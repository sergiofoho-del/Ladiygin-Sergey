// Страница приложения: загружает страницы Яндекс Архива в рабочей вкладке Chrome
// (где вы уже вошли в Яндекс), разбирает текст и сохраняет результат в Excel.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const CFG = {
    PAGE_URL: (fileId, n) => `https://ya.ru/archive/catalog/${fileId}/${n}`,
    DELAY: [1000, 2500],     // пауза между страницами, мс
    PAGE_TIMEOUT: 45000,     // ожидание загрузки страницы, мс
    MAX_RETRIES: 2,
    RENDER_WAIT: 15000,      // сколько ждать появления распознанного текста, мс
    BIG_RANGE: 300,          // предупреждение о слишком большом диапазоне
    MAX_MISSES: 3,           // подряд страниц без окна текста — остановка
  };
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const NEEDS_USER = /captcha|passport\.yandex|\/auth/i;

  let linksDoc = null;       // разобранный HTML со ссылками
  let items = [];            // ссылки
  let running = false;
  let stopRequested = false;
  let resumeResolver = null;
  let workTabId = null;
  let appTabId = null;
  let fileHandle = null;
  let debugSaved = false;
  let debugStamp = '';        // папка текущего запуска: yaarchive_debug/<время>
  let linksDir = null;        // папка, где лежит файл ссылок (FileSystemDirectoryHandle); туда пишется yaarchive_debug/
  let runDir = null;          // yaarchive_debug/<время>/ внутри linksDir
  let writeChain = Promise.resolve();   // записи в папку идут по очереди
  let debugIndex = [];        // сводка по страницам для run_summary.json
  let busyPicking = false;

  let settings = { mode: Logic.DEFAULT_MODE, textSel: '', dateSel: '' };

  let families = [];         // семьи-дворы: {settlement, yard, persons[], notes[], url, year}
  let sheetRows = [];
  let linkRows = [];
  let blockRecords = [];     // блоки текста (исповедные ведомости) — для проверки деления на людей
  let rowRecords = [];       // строки таблицы внутри блоков «Крестьяне/Крестьянки» (режим «Ревизские сказки»)

  // ---------------------------------------------------------------- UI
  function log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    const el = $('log');
    el.textContent += `[${t}] ${msg}\n`;
    el.scrollTop = el.scrollHeight;
  }
  function setStatus(s) { $('status').textContent = s; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = ([a, b]) => a + Math.random() * (b - a);
  const mode = () => Logic.getMode(settings.mode);

  function setRunningUi(on) {
    $('startBtn').disabled = on;
    $('linksFile').disabled = on;
    $('pickDirBtn').disabled = on;
    $('linksSel').disabled = on;
    document.querySelectorAll('input[name="mode"]').forEach((r) => { r.disabled = on; });
    $('pickTextBtn').disabled = on;
    $('pickDateBtn').disabled = on;
    $('resetSelBtn').disabled = on;
    $('saveBtn').disabled = !on;
    $('stopBtn').disabled = !on;
  }

  function showSelectors() {
    $('textSelInfo').textContent = settings.textSel || 'автоопределение (справа от окна со сканом)';
    $('dateSelInfo').textContent = settings.dateSel || 'автоопределение (выше панели инструментов окна со сканом)';
  }

  // ---------------------------------------------------------------- настройки
  async function loadSettings() {
    try {
      const got = await chrome.storage.local.get(['mode', 'textSel', 'dateSel']);
      if (got.mode && Logic.MODES[got.mode]) settings.mode = got.mode;
      settings.textSel = got.textSel || '';
      settings.dateSel = got.dateSel || '';
    } catch (e) { /* без сохранения — не критично */ }
  }
  async function saveSettings() {
    try { await chrome.storage.local.set(settings); } catch (e) { /* ignore */ }
  }

  function applyModeUi() {
    $('descConfession').textContent = Logic.MODES.confession.description;
    $('descRevision').textContent = Logic.MODES.revision.description;
    document.querySelectorAll('input[name="mode"]').forEach((r) => { r.checked = r.value === settings.mode; });
  }

  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      settings.mode = r.value;
      await saveSettings();
      reparseLinks();
      log(`Тип обработки: ${mode().label}.`);
    });
  });

  // ------------------------------------------------------------- ожидание пользователя
  function waitForUser(text, showWorkTab) {
    $('bannerText').textContent = text;
    $('banner').style.display = 'block';
    if (showWorkTab && workTabId !== null) chrome.tabs.update(workTabId, { active: true }).catch(() => {});
    return new Promise((resolve) => {
      resumeResolver = () => {
        $('banner').style.display = 'none';
        resumeResolver = null;
        if (showWorkTab && appTabId !== null && !$('showTab').checked) {
          chrome.tabs.update(appTabId, { active: true }).catch(() => {});
        }
        resolve();
      };
    });
  }
  $('continueBtn').addEventListener('click', () => resumeResolver && resumeResolver());
  $('stopBtn').addEventListener('click', () => {
    stopRequested = true;
    log('Остановка запрошена — дорабатываю текущую страницу и сохраняю результат...');
    if (resumeResolver) resumeResolver();
  });
  $('saveBtn').addEventListener('click', async () => { await saveResult(true); });
  window.addEventListener('beforeunload', (e) => {
    if (running) { e.preventDefault(); e.returnValue = ''; }
  });

  // ------------------------------------------------------ список ссылок
  function reparseLinks() {
    items = linksDoc ? Logic.parseLinks(linksDoc, settings.mode) : [];
    if (!linksDoc) return;
    const ok = items.filter((i) => i.fileId && i.pFrom !== null).length;
    $('linksInfo').textContent = items.length
      ? `Найдено ссылок Яндекс Архива: ${items.length} (с номером документа и диапазоном: ${ok})`
      : 'В файле не найдено ссылок Яндекс Архива.';
  }

  // ---- папка с файлом ссылок: в неё же сохраняются результаты (yaarchive_debug/<время запуска>/)
  const IDB = { db: 'yaarchive', store: 'handles' };
  function idb(fn) {
    return new Promise((resolve, reject) => {
      const rq = indexedDB.open(IDB.db, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(IDB.store);
      rq.onerror = () => reject(rq.error);
      rq.onsuccess = () => {
        const tx = rq.result.transaction(IDB.store, 'readwrite');
        const r = fn(tx.objectStore(IDB.store));
        tx.oncomplete = () => resolve(r && r.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  const outLabel = () => (linksDir ? `«${linksDir.name}/yaarchive_debug/${debugStamp || '<время запуска>'}/»`
    : `«Загрузки/yaarchive_debug/${debugStamp || '<время запуска>'}/»`);

  async function dirPermission(handle, ask) {
    const o = { mode: 'readwrite' };
    if ((await handle.queryPermission(o)) === 'granted') return true;
    return ask ? (await handle.requestPermission(o)) === 'granted' : false;
  }

  async function useLinksDir(handle) {
    linksDir = handle;
    const files = [];
    for await (const [name, h] of handle.entries()) {
      if (h.kind === 'file' && /\.html?$/i.test(name)) files.push(name);
    }
    files.sort((a, b) => (a === 'list_links.html' ? -1 : b === 'list_links.html' ? 1 : a.localeCompare(b)));
    const sel = $('linksSel');
    sel.innerHTML = '';
    files.forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
    sel.hidden = files.length < 2;
    $('dirInfo').textContent = `Папка: ${handle.name}. Результаты: ${handle.name}/yaarchive_debug/<время запуска>/`;
    $('pickDirBtn').textContent = 'Выбрать другую папку';
    if (!files.length) {
      linksDoc = null; items = [];
      $('linksInfo').textContent = 'В папке нет HTML-файла со ссылками (.html).';
      return;
    }
    await loadLinksFromDir(files[0]);
  }

  async function loadLinksFromDir(name) {
    try {
      const f = await (await linksDir.getFileHandle(name)).getFile();
      linksDoc = new DOMParser().parseFromString(await f.text(), 'text/html');
      reparseLinks();
      $('linksInfo').textContent = `${name}: ` + $('linksInfo').textContent;
    } catch (err) {
      linksDoc = null; items = [];
      $('linksInfo').textContent = `Не удалось прочитать ${name}: ${err.message}`;
    }
  }

  $('pickDirBtn').addEventListener('click', async () => {
    // запомненная папка: подтвердить доступ одним кликом
    if (linksDir && !(await dirPermission(linksDir, false))) {
      if (await dirPermission(linksDir, true)) { await useLinksDir(linksDir); return; }
    }
    if (!window.showDirectoryPicker) { $('dirInfo').textContent = 'Этот Chrome не умеет выбирать папку — выберите файл ниже.'; return; }
    try {
      const h = await window.showDirectoryPicker({ id: 'yaarchive-links', mode: 'readwrite' });
      await idb((st) => st.put(h, 'linksDir')).catch(() => {});
      await useLinksDir(h);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      $('dirInfo').textContent = 'Папку выбрать не удалось: ' + (e && e.message) +
        ' (Chrome не даёт доступ к корню диска и системным папкам — выберите вложенную папку).';
    }
  });
  $('linksSel').addEventListener('change', () => loadLinksFromDir($('linksSel').value));

  $('linksFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    linksDir = null;          // выбран отдельный файл: сохранение в «Загрузки/yaarchive_debug/…»
    $('dirInfo').textContent = 'Папка не выбрана: результаты — в «Загрузки/yaarchive_debug/<время запуска>/»';
    $('linksSel').hidden = true;
    linksDoc = null;
    items = [];
    if (!f) { $('linksInfo').textContent = 'Файл не выбран'; return; }
    try {
      linksDoc = new DOMParser().parseFromString(await f.text(), 'text/html');
    } catch (err) {
      $('linksInfo').textContent = 'Не удалось прочитать файл: ' + err.message;
      return;
    }
    reparseLinks();
  });

  // ------------------------------------------------------ рабочая вкладка
  async function getWorkTab() {
    if (workTabId !== null) {
      try { await chrome.tabs.get(workTabId); return workTabId; } catch (e) { workTabId = null; }
    }
    const t = await chrome.tabs.create({ url: 'about:blank', active: $('showTab').checked });
    workTabId = t.id;
    return workTabId;
  }

  function navigate(tabId, url, timeoutMs) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let sawLoading = false;
      const done = (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpd);
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => done(new Error('таймаут загрузки страницы')), timeoutMs);
      const onUpd = (id, info) => {
        if (id !== tabId) return;
        if (info.status === 'loading') sawLoading = true;
        if (info.status === 'complete' && sawLoading) done();
      };
      chrome.tabs.onUpdated.addListener(onUpd);
      chrome.tabs.update(tabId, { url }).catch((e) => done(e));
    });
  }

  async function fetchSheet(fileId, n) {
    const url = CFG.PAGE_URL(fileId, n);
    let lastErr = '';
    for (let attempt = 0; attempt <= CFG.MAX_RETRIES; attempt++) {
      if (stopRequested) return { url, text: '', date: '', found: false, err: 'остановлено пользователем' };
      try {
        const tabId = await getWorkTab();
        await navigate(tabId, url, CFG.PAGE_TIMEOUT);
        let tab = await chrome.tabs.get(tabId);
        let guard = 0;
        while (NEEDS_USER.test(tab.url || '') && guard++ < 3 && !stopRequested) {
          const captcha = /captcha/i.test(tab.url);
          await waitForUser(
            captcha
              ? 'Яндекс просит капчу. Решите её в рабочей вкладке и нажмите «Продолжить».'
              : 'Сессия Яндекса сбросилась. Войдите заново в рабочей вкладке и нажмите «Продолжить».',
            true
          );
          await navigate(tabId, url, CFG.PAGE_TIMEOUT);
          tab = await chrome.tabs.get(tabId);
        }
        if ((tab.url || '').startsWith('chrome-error')) throw new Error('страница не загрузилась (ошибка сети)');

        const wantHtml = $('debugHtml').checked && !debugSaved;
        const [inj] = await chrome.scripting.executeScript({
          target: { tabId },
          func: PageScripts.pageExtractor,
          args: [{ textSel: settings.textSel, dateSel: settings.dateSel, maxWait: CFG.RENDER_WAIT, wantHtml,
                  useNext: true }],
        });
        const res = (inj && inj.result) || { found: false, text: '', date: '' };
        if (wantHtml && res.html) {
          saveOut('first_page.html', new Blob([res.html], { type: 'text/html;charset=utf-8' }));
          if (res.debug) saveOut('first_page_debug.json', new Blob([JSON.stringify(res.debug)], { type: 'application/json' }));
          if (res.nextNode) saveOut('first_page_next_data.json', new Blob([JSON.stringify(res.nextNode)], { type: 'application/json' }));
          debugSaved = true;
          log(`Отладочные файлы первой страницы: ${outLabel()} first_page.html, first_page_debug.json / first_page_next_data.json.`);
        }
        if (n !== undefined && res.nextNode) {
          log(`  стр. ${n}: данные страницы (${res.nextHow}), блоков: ${res.nextNode.joinedTextBlocks.length}`);
        } else if (n !== undefined && res.found) {
          log(`  стр. ${n}: окно текста — ${res.textHow}, знаков: ${res.text.length}; ` +
              `блоков с координатами: в окне текста ${(res.textBlocks || []).length}, на скане ${(res.overlayBlocks || []).length}`);
        }
        return {
          url, text: res.text || '', date: res.date || '', found: !!res.found, nextNode: res.nextNode || null,
          candidates: [
            { name: 'окно текста', blocks: res.textBlocks || [] },
            { name: 'скан', blocks: res.overlayBlocks || [] },
          ],
          err: res.found ? '' : 'окно распознанного текста не найдено',
        };
      } catch (e) {
        lastErr = e && e.message ? e.message : String(e);
        log(`  страница ${n}: ошибка «${lastErr}», попытка ${attempt + 1}/${CFG.MAX_RETRIES + 1}`);
        await sleep(2000);
      }
    }
    return { url, text: '', date: '', found: false, err: lastErr || 'ошибка' };
  }

  async function ensureLogin() {
    const tabId = await getWorkTab();
    log('Проверяю вход в Яндекс...');
    try {
      await navigate(tabId, 'https://ya.ru/archive', 60000);
    } catch (e) {
      log('Страница ya.ru/archive открылась с ошибкой: ' + e.message);
    }
    const tab = await chrome.tabs.get(tabId);
    const onArchive = /^https:\/\/(ya\.ru|yandex\.ru)\/archive/.test(tab.url || '');
    if (!onArchive || NEEDS_USER.test(tab.url || '')) {
      await waitForUser(
        'Войдите в Яндекс в рабочей вкладке (она сейчас открыта; убедитесь, что там открыт ya.ru/archive), ' +
        'затем вернитесь на эту вкладку и нажмите «Продолжить».',
        true
      );
      if (stopRequested) return;
    }
    // прогреваем сессию на втором домене (yandex.ru) — на случай ссылок с ним
    try {
      await navigate(tabId, 'https://yandex.ru/archive', 30000);
      await navigate(tabId, 'https://ya.ru/archive', 30000);
    } catch (e) { /* не критично */ }
    log('Вход проверен.');
  }

  // ------------------------------------------------------ ручная калибровка
  async function calibrate(kind) {
    if (running || busyPicking) return;
    const it = items.find((i) => i.fileId && i.pFrom !== null);
    if (!it) { setStatus('Сначала выберите HTML-файл со ссылками: расширение откроет первую из них.'); return; }
    busyPicking = true;
    const label = kind === 'text' ? 'окно расшифрованного текста (справа от скана)' : 'строку с датой документа (над панелью инструментов скана)';
    try {
      if (appTabId === null) { const cur = await chrome.tabs.getCurrent(); appTabId = cur ? cur.id : null; }
      const tabId = await getWorkTab();
      await chrome.tabs.update(tabId, { active: true });
      log(`Калибровка: открываю страницу ${it.pFrom} документа ${it.fileId}...`);
      try { await navigate(tabId, CFG.PAGE_URL(it.fileId, it.pFrom), CFG.PAGE_TIMEOUT); }
      catch (e) { log('Страница открылась с ошибкой: ' + e.message); }
      const tab = await chrome.tabs.get(tabId);
      if (NEEDS_USER.test(tab.url || '')) {
        log('Нужен вход или капча: выполните их в открытой вкладке и нажмите кнопку калибровки ещё раз.');
        return;
      }
      await sleep(3500);   // дать странице дорисоваться
      log(`В рабочей вкладке наведите мышь на ${label} и кликните. Esc — отмена.`);
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId }, func: PageScripts.pickerRun, args: [label],
      });
      const res = inj && inj.result;
      if (!res) { log('Выбор отменён.'); return; }
      if (kind === 'text') settings.textSel = res.selector; else settings.dateSel = res.selector;
      await saveSettings();
      showSelectors();
      log(`Выбрано: ${res.selector} (совпадений: ${res.count}).`);
      log(`Начало содержимого: «${res.sample.replace(/\s+/g, ' ').slice(0, 160)}»`);
      if (res.count !== 1) log('Внимание: селектор подходит не к одному элементу — проверьте результат.');
    } catch (e) {
      log('Калибровка не удалась: ' + (e && e.message ? e.message : e));
    } finally {
      busyPicking = false;
      if (appTabId !== null) chrome.tabs.update(appTabId, { active: true }).catch(() => {});
    }
  }
  $('pickTextBtn').addEventListener('click', () => calibrate('text'));
  $('pickDateBtn').addEventListener('click', () => calibrate('date'));
  $('resetSelBtn').addEventListener('click', async () => {
    settings.textSel = '';
    settings.dateSel = '';
    await saveSettings();
    showSelectors();
    log('Сброшено на автоопределение.');
  });

  // ------------------------------------------------------------- Excel
  const trunc = (v) => (typeof v === 'string' ? v.slice(0, 32000) : v === null || v === undefined ? '' : v);

  function widthsFor(rows) {
    const cols = Math.max(...rows.map((r) => r.length));
    const out = [];
    for (let c = 0; c < cols; c++) {
      let w = 8;
      rows.slice(0, 200).forEach((r) => {
        const v = r[c];
        if (v !== '' && v !== null && v !== undefined) w = Math.max(w, String(v).length);
      });
      out.push(Math.min(Math.max(w + 2, 10), 70));
    }
    return out;
  }

  // «45» -> 45; «7 1/2» -> 7.5; «1/2» -> 0.5
  function ageValue(age) {
    const m = String(age || '').match(/^\s*(\d{1,3})?\s*(?:(\d)\s*\/\s*(\d))?/);
    if (!m || !(m[1] || m[2])) return null;
    return parseInt(m[1] || '0', 10) + (m[2] ? parseInt(m[2], 10) / parseInt(m[3], 10) : 0);
  }
  // год рождения = год ведомости − полных лет (±1 год: ведомость составлялась в течение года)
  function birthYear(year, age) {
    const v = ageValue(age), y = parseInt(year, 10);
    return v === null || !y ? '' : y - Math.floor(v);
  }

  function buildSheets() {
    if (settings.mode === 'confession') return buildConfessionSheets();
    // Одна строка = одна семья-двор. Все люди двора — в одной ячейке (каждый с новой строки).
    // Ссылка на страницу — только у строки семьи-двора.
    const peopleRows = [['Год', 'Населённый пункт', 'Двор №', settings.mode === 'confession'
      ? 'Люди двора: текст блока как распознан; под ним строки таблицы — № мужчины/женщины, лѣта'
      : 'Люди двора (№ м/ж, как распознано, возраст)', 'Примечание', 'Ссылка на страницу']];
    families.forEach((f) => peopleRows.push([f.year, f.settlement, f.yard, Layout.familyCell(f), f.notes.join('; '), f.url].map(trunc)));

    const pageRows = [['Год', 'Найденные НП округи', 'Ссылка', 'Распознанный текст страницы', 'Проверка итогов страницы']];
    sheetRows.forEach((r) => pageRows.push([r.year, r.found, r.url, r.text, r.check || ''].map(trunc)));

    let detailRows;
    if (settings.mode === 'confession') {
      detailRows = [['Год', 'Населённый пункт', 'Двор №', 'Лист разворота', 'Пол', '№ мужчины / женщины', 'Лѣта', 'Строка в блоке №',
        'Текст блока (список людей)', 'Проверка', 'Ссылка на страницу']];
      rowRecords.forEach((r) => detailRows.push([r.year, r.settlement, r.yard, r.half, r.sex, r.no, r.age, r.inBlock, r.names, r.flags, r.url].map(trunc)));
    } else {
      detailRows = [['Год', 'Населённый пункт', 'Двор №', 'Пол', 'Блок №', 'Строка №', 'Строк в блоке', 'Текст блока (список людей)',
        'Лѣта по ревизии', 'Когда выбыл', 'В отлучке с', 'Лѣта нынѣ', 'Проверка', 'Ссылка на страницу']];
      rowRecords.forEach((r) => detailRows.push([r.year, r.settlement, r.yard, r.sex, r.blockNo, r.rowNo, r.rowsInBlock, r.names,
        r.agePrev, r.departed, r.absent, r.ageNow, r.flags, r.url].map(trunc)));
    }

    const linkOut = [['Год', 'Исходная ссылка', 'Диапазон из ссылки', 'Просмотрено страниц',
      'Найдено НП (шт.)', 'Какие НП', 'Решение', 'Дворов (семей)', 'Людей', 'Как собрано', 'Примечание']];
    linkRows.forEach((r) => linkOut.push(r.map(trunc)));

    const w = (rows) => widthsFor(rows);
    const peopleWidths = w(peopleRows);
    peopleWidths[3] = 60;
    const sheets = [{ name: 'Люди', rows: peopleRows, widths: peopleWidths }];
    if (rowRecords.length) {
      const dw = w(detailRows);
      dw[settings.mode === 'confession' ? 8 : 7] = 50;
      sheets.push({ name: 'Строки', rows: detailRows, widths: dw });
    }
    sheets.push({ name: 'Страницы', rows: pageRows, widths: w(pageRows) });
    sheets.push({ name: 'Ссылки', rows: linkOut, widths: w(linkOut) });
    return sheets;
  }

  // Исповедные ведомости: одна строка Excel = один человек. Текст Основного блока поделён по людям,
  // номер (м№/ж№) и возраст — в своих столбцах напротив человека, год рождения рассчитан.
  function buildConfessionSheets() {
    const head = ['Год', 'Населённый пункт', 'Двор №', 'Человек (как распознано)', 'Пол', 'Номер', 'Возраст', 'Год рождения',
      'Примечание', 'Ссылка на страницу'];
    const people = [head];
    const yards = ConfessionRows.fillYards(rowRecords);
    rowRecords.forEach((r, i) => {
      const yd = yards[i];
      let notes = (r.notes || []).slice();
      if (yd.calc) {
        notes = notes.filter((n) => !/^номер двора не найден/.test(n));
        if (i === 0 || !yards[i - 1].calc || yards[i - 1].yard !== yd.yard) notes.unshift(`номер двора ${yd.yard} вычислен по соседним дворам`);
      }
      people.push([r.year, r.settlement, yd.yard, r.person, r.sex,
        r.no === '' ? '' : (parseInt(r.no, 10) || r.no), r.age === '' ? '' : (/^\d+$/.test(String(r.age)) ? parseInt(r.age, 10) : r.age),
        birthYear(r.year, r.age), notes.join('; '), r.url].map(trunc));
    });
    // Объединение: «Населённый пункт» — до следующего НП (в пределах документа), «Двор №» — по строкам людей двора.
    const merges = [];
    const runs = (col, key) => {
      let st = 1;
      for (let r = 2; r <= people.length; r++) {
        if (r === people.length || key(r) !== key(st)) {
          if (r - 1 > st) merges.push([st, col, r - 1, col]);
          st = r;
        }
      }
    };
    const S = XlsxWriter.STYLE;
    runs(1, (r) => `${people[r][0]}|${people[r][1]}`);
    runs(2, (r) => (people[r][2] === '' || people[r][2] == null) ? `empty${r}`
      : `${people[r][0]}|${people[r][1]}|${people[r][2]}|${yards[r - 1].calc}`);
    const styleAt = (r, c) => (c === 1 ? S.SETTLEMENT : c === 2 ? (yards[r - 1] && yards[r - 1].calc ? S.YARD_CALC : S.YARD)
      : c === 3 ? S.PERSON : undefined);
    const pw = widthsFor(people);
    pw[1] = 9; pw[2] = 7; pw[3] = 45; pw[8] = 40;
    const blocks = [['Год', 'Населённый пункт', 'Двор №', 'Текст блока целиком (как распознан)', 'Людей в блоке', 'Ссылка на страницу']];
    blockRecords.forEach((b) => blocks.push([b.year, b.settlement, b.yard, b.text, b.persons, b.url].map(trunc)));
    const bw = widthsFor(blocks); bw[3] = 70;
    const pageRows = [['Год', 'Найденные НП округи', 'Ссылка', 'Распознанный текст страницы', 'Проверка страницы (найдено ячеек по столбцам)']];
    sheetRows.forEach((r) => pageRows.push([r.year, r.found, r.url, r.text, r.check || ''].map(trunc)));
    const linkOut = [['Год', 'Исходная ссылка', 'Диапазон из ссылки', 'Просмотрено страниц',
      'Найдено НП (шт.)', 'Какие НП', 'Решение', 'Дворов (семей)', 'Людей', 'Как собрано', 'Примечание']];
    linkRows.forEach((r) => linkOut.push(r.map(trunc)));
    return [
      { name: 'Люди', rows: people, widths: pw, styleAt, merges },
      { name: 'Блоки текста', rows: blocks, widths: bw },
      { name: 'Страницы', rows: pageRows, widths: widthsFor(pageRows) },
      { name: 'Ссылки', rows: linkOut, widths: widthsFor(linkOut) },
    ];
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // Все результаты и отладочные файлы запуска — в одну папку yaarchive_debug/<время запуска>/:
  //  выбрана папка со ссылками -> прямо в неё (File System Access API);
  //  выбран только файл        -> «Загрузки/yaarchive_debug/<время>/» (chrome.downloads), иначе обычное скачивание.
  async function writeToRunDir(name, blob) {
    if (!runDir) {
      const dbg = await linksDir.getDirectoryHandle('yaarchive_debug', { create: true });
      runDir = await dbg.getDirectoryHandle(debugStamp, { create: true });
    }
    const w = await (await runDir.getFileHandle(name, { create: true })).createWritable();
    await w.write(blob);
    await w.close();
  }
  function downloadToFolder(name, blob) {
    const fname = `yaarchive_debug/${debugStamp}/${name}`;
    try {
      if (chrome.downloads && chrome.downloads.download) {
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({ url, filename: fname, conflictAction: 'overwrite', saveAs: false }, () => {
          setTimeout(() => URL.revokeObjectURL(url), 30000);
        });
        return;
      }
    } catch (e) { /* запасной путь ниже */ }
    downloadBlob(blob, fname.replace(/\//g, '_'));
  }
  function localStamp() {      // местное время: 2026-10-27_10-52-03
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
  }
  function saveOut(name, blob) {
    if (!debugStamp) debugStamp = localStamp();
    writeChain = writeChain.then(async () => {
      if (linksDir) {
        try { await writeToRunDir(name, blob); return; } catch (e) {
          log(`Не удалось записать ${name} в папку ${linksDir.name} (${e.message}) — сохраняю в «Загрузки».`);
        }
      }
      downloadToFolder(name, blob);
    });
    return writeChain;
  }
  function saveDebug(name, obj) {
    if (!$('debugAll').checked) return;
    saveOut(name, new Blob([typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1)], { type: 'application/json' }));
  }

  // Excel всегда сохраняется в папку запуска (result.xlsx, перезаписывается по ходу работы);
  // если выбран «спросить, куда сохранить» — ещё и копия в выбранный файл.
  async function saveResult(final) {
    const bytes = await XlsxWriter.build(buildSheets());
    await saveOut('result.xlsx', new Blob([bytes], { type: XLSX_MIME }));
    if (fileHandle) {
      try {
        const w = await fileHandle.createWritable();
        await w.write(bytes);
        await w.close();
      } catch (e) {
        log('Не удалось записать в выбранный файл (' + e.message + ').');
      }
    }
    if (final) log(`Excel сохранён: ${outLabel()} result.xlsx (дворов ${families.length}, страниц ${sheetRows.length}).`);
    return true;
  }

  // ------------------------------------------------------------ основной цикл
  async function run() {
    running = true;
    stopRequested = false;
    debugSaved = false;
    debugIndex = [];
    debugStamp = localStamp();
    runDir = null;
    families = [];
    sheetRows = [];
    linkRows = [];
    rowRecords = [];
    blockRecords = [];
    const m = mode();
    const pageCache = new Map();     // `${fileId}:${page}` -> {url,text,date,found,err}
    let misses = 0;
    setRunningUi(true);
    log(`Тип обработки: ${m.label}. Окно текста: ${settings.textSel || 'авто'}; дата: ${settings.dateSel || 'авто'}.`);

    try {
      const cur = await chrome.tabs.getCurrent();
      appTabId = cur ? cur.id : null;
      await ensureLogin();

      for (let idx = 0; idx < items.length && !stopRequested; idx++) {
        const it = items[idx];
        const tag = `[${idx + 1}/${items.length}] ${it.year ?? '—'}`;
        const rng = it.pFrom !== null ? `${it.pFrom}–${it.pTo}` : '—';

        if (!it.fileId || it.pFrom === null) {
          linkRows.push([it.year, it.url, rng, 0, 0, '', 'пропущена: нет fileId или диапазона', 0, 0, '', it.note]);
          log(`${tag}: пропущена (нет fileId/диапазона)`);
          continue;
        }

        const lo = it.pFrom;
        const hi = it.pTo;
        if (hi - lo + 1 > CFG.BIG_RANGE) log(`${tag}: внимание, диапазон очень большой (${hi - lo + 1} страниц)`);

        // 1. загрузка страниц диапазона из ссылки
        const texts = new Map();
        for (let n = lo; n <= hi && !stopRequested; n++) {
          const key = `${it.fileId}:${n}`;
          if (!pageCache.has(key)) {
            setStatus(`${tag}: страница ${n} (диапазон ${lo}–${hi})`);
            log(`${tag}: загружаю страницу ${n} (диапазон ${lo}–${hi})...`);
            const r = await fetchSheet(it.fileId, n);
            pageCache.set(key, r);
            if (!r.found && !stopRequested) {
              if (++misses >= CFG.MAX_MISSES) {
                stopRequested = true;
                log(`Окно распознанного текста не найдено на ${CFG.MAX_MISSES} страницах подряд — останавливаюсь, ` +
                    'чтобы не собирать лишнее. Нажмите «Указать окно текста вручную» и запустите снова.');
              }
            } else if (r.found) {
              misses = 0;
            }
            if (n < hi) await sleep(rand(CFG.DELAY));
          }
          texts.set(n, pageCache.get(key));
        }

        // 2. сбор людей
        const foundAll = new Set();
        const perPage = new Map();
        for (const [n, r] of texts) {
          const f = Logic.findSettlements(r.text, m.id);
          perPage.set(n, f);
          f.forEach((x) => foundAll.add(x));
        }

        const state = Layout.newState();
        const fams = [];
        const hows = new Set();
        const yrOf = (v) => { const mm = String(v || '').match(/(?<!\d)(1[5-9]\d\d)(?!\d)/); return mm ? parseInt(mm[1], 10) : null; };
        for (const n of [...texts.keys()].sort((a, b) => a - b)) {
          const r = texts.get(n);
          const sr = {
            year: it.year, page: n,
            found: [...perPage.get(n)].sort().join('; '),
            url: r.url, text: r.err ? `ОШИБКА: ${r.err}` : r.text, check: '',
          };
          sheetRows.push(sr);
          if (r.err) continue;
          let how = null;
          if (r.nextNode && m.id === 'revision') how = Layout.processNode(r.nextNode, { url: r.url, page: n }, state, m.id, fams);
          if (r.nextNode && m.id === 'confession') {
            state.lastRep = null;
            how = Layout.processConfessionNode(r.nextNode, { url: r.url, page: n, year: it.year }, state, m.id, fams);
            const tag8 = String(it.fileId).slice(0, 8);
            saveDebug(`${it.year || 'год'}_${tag8}_p${n}_next_data.json`, { props: { pageProps: { url: r.url, docNumber: n, currentNode: r.nextNode } } });
            if (state.lastRep) {
              for (const mk of state.lastRep.settlement_marks) if (!String(mk.name).startsWith('other:')) { perPage.get(n).add(mk.name); foundAll.add(mk.name); }
              sr.found = [...perPage.get(n)].sort().join('; ');
            }
            if (state.lastRep) saveDebug(`${it.year || 'год'}_${tag8}_p${n}_confession.json`, state.lastRep);
            debugIndex.push({ year: it.year, fileId: it.fileId, page: n, url: r.url, how,
              flags: state.lastRep ? state.lastRep.flags : [], halves: state.lastRep ? state.lastRep.halves.map((h) => ({ no: h.no, columns: h.columns, people: h.people })) : [],
              check: state.checks[n] || '' });
          }
          if (!how) how = Layout.processPage({ candidates: r.candidates, text: r.text, url: r.url, page: n }, state, m.id, fams);
          sr.check = state.checks[n] || '';
          hows.add(how);
        }
        Layout.finish(state, fams);
        const docYear = it.year || yrOf(it.url) || '';
        fams.forEach((f) => { f.year = docYear; });
        families.push(...fams);
        state.rows.forEach((r) => rowRecords.push(Object.assign({ year: docYear }, r)));
        (state.blocks || []).forEach((b) => blockRecords.push(Object.assign({ year: docYear }, b)));
        const persons = m.id === 'confession'
          ? fams.reduce((acc, f) => acc + f.persons.reduce((a, p) => a + (p.rows && p.rows.length ? p.rows.length : 1), 0), 0)
          : fams.reduce((acc, f) => acc + f.persons.length, 0);

        const total = hi - lo + 1;
        const verdict = texts.size < total
          ? `ПРЕРВАНА (страниц ${texts.size} из ${total})`
          : 'ОБРАБОТАНА';
        linkRows.push([it.year, it.url, rng, texts.size, foundAll.size,
          [...foundAll].sort().join('; '), verdict, fams.length, persons, [...hows].join('; '),
          [it.note, state.dropped ? `отброшено служебных строк: ${state.dropped}` : '',
            state.orphans ? `несопоставленных ячеек: ${state.orphans}` : '',
            state.skipped.length ? `страницы без таблицы: ${state.skipped.join(', ')}` : ''].filter(Boolean).join('; ')]);
        log(`${tag}: диапазон ${rng} — НП ${foundAll.size}, дворов: ${fams.length}, людей: ${persons} (${[...hows].join('; ')})`);
        await saveResult(false);
      }
    } catch (e) {
      log('ОШИБКА: ' + (e && e.stack ? e.stack : e));
    } finally {
      try { await saveResult(true); } catch (e) { log('Не удалось сохранить: ' + e.message); }
      if ($('debugAll').checked && debugIndex.length) {
        saveDebug('run_summary.json', { version: chrome.runtime.getManifest().version, mode: settings.mode, pages: debugIndex, links: linkRows });
        log(`Отладочный пакет: ${outLabel()} (страниц: ${debugIndex.length}). Пришлите эту папку на анализ.`);
      }
      if (workTabId !== null) { chrome.tabs.remove(workTabId).catch(() => {}); workTabId = null; }
      running = false;
      setRunningUi(false);
      setStatus(`Готово. Дворов: ${families.length}. Результаты: ${outLabel()}`);
      log(`Готово. Дворов: ${families.length}. Результаты: ${outLabel()}`);
      saveOut('run_log.txt', new Blob([$('log').textContent], { type: 'text/plain;charset=utf-8' }));
      try { await writeChain; } catch (e) { /* ошибки уже в журнале */ }
    }
  }

  $('startBtn').addEventListener('click', async () => {
    if (running || busyPicking) return;
    if (!items.length) { setStatus('Сначала выберите HTML-файл со ссылками.'); return; }
    // доступ к запомненной папке подтверждается прямо по клику (без него — сохранение в «Загрузки»)
    if (linksDir && !(await dirPermission(linksDir, true))) {
      log(`Нет доступа к папке ${linksDir.name} — результаты будут сохранены в «Загрузки/yaarchive_debug/…».`);
      linksDir = null;
    }
    fileHandle = null;
    if ($('askSave').checked && window.showSaveFilePicker) {
      try {
        fileHandle = await window.showSaveFilePicker({
          suggestedName: 'result.xlsx',
          types: [{ description: 'Excel', accept: { [XLSX_MIME]: ['.xlsx'] } }],
        });
      } catch (e) {
        if (e && e.name === 'AbortError') { setStatus('Место сохранения копии не выбрано.'); return; }
        log('Окно выбора файла недоступно (' + (e && e.message) + ').');
      }
    }
    await run();
  });

  // ------------------------------------------------------------- старт
  (async () => {
    await loadSettings();
    applyModeUi();
    showSelectors();
    try { const cur = await chrome.tabs.getCurrent(); appTabId = cur ? cur.id : null; } catch (e) { /* ignore */ }
    // запомненная папка со ссылками
    try {
      const h = await idb((st) => st.get('linksDir'));
      if (h) {
        linksDir = h;
        if (await dirPermission(h, false)) await useLinksDir(h);
        else {
          $('dirInfo').textContent = `Запомнена папка «${h.name}» — нажмите кнопку выше, чтобы подтвердить доступ (или выберите другую).`;
          $('pickDirBtn').textContent = `Открыть папку «${h.name}»`;
        }
      }
    } catch (e) { /* нет сохранённой папки */ }
  })();
})();
