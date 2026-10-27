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

  // outFormat — вид результата в Excel ('confession' | 'revision'), не зависит от типа обработки;
  // saveScans — сохранять оригиналы сканов в «Archive_Scans»
  let settings = { mode: Logic.DEFAULT_MODE, textSel: '', dateSel: '', outFormat: '', saveScans: false };

  let families = [];         // семьи-дворы: {settlement, yard, persons[], notes[], url, year}
  let sheetRows = [];
  let linkRows = [];
  let blockRecords = [];     // блоки текста (исповедные ведомости) — для проверки деления на людей
  let rowRecords = [];       // строки таблицы внутри блоков «Крестьяне/Крестьянки» (режим «Ревизские сказки»)
  let pageMeta = {};         // адрес страницы -> {cga, cgaUrl, scanName, scanFile, scanHref} для столбцов ссылок
  const SCAN_DIR = 'Archive_Scans';
  const SCAN_QUALITY = 0.4;  // JPG 40%, как в Scrpt_YA_Orig_Scan
  let scanDir = null;        // FileSystemDirectoryHandle «Archive_Scans» в папке со ссылками
  let scanStats = { saved: 0, existed: 0, failed: 0, bytes: 0 };

  // ---------------------------------------------------------------- UI
  function log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    const el = $('log');
    el.textContent += `[${t}] ${msg}\n`;
    el.scrollTop = el.scrollHeight;
  }
  function setStatus(s) { $('status').textContent = s; }

  // шкала времени до окончания: всего страниц по всем ссылкам (без повторов), сделано, среднее время страницы
  const progress = { total: 0, done: 0, t0: 0, times: [] };
  const fmtDur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ' ч ' : '') + (h || m ? m + ' мин ' : '') + (h ? '' : sec + ' с');
  };
  function progressStart(total) {
    Object.assign(progress, { total, done: 0, t0: Date.now(), times: [] });
    $('progressBox').style.display = 'block';
    $('progressBar').max = Math.max(total, 1);
    progressShow();
  }
  function progressStep(ms) {
    progress.done++;
    if (ms !== undefined) { progress.times.push(ms); if (progress.times.length > 30) progress.times.shift(); }
    progressShow();
  }
  function progressShow(final) {
    const { total, done, t0, times } = progress;
    $('progressBar').value = Math.min(done, total);
    const spent = Date.now() - t0;
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    const left = Math.max(0, total - done) * avg;
    const pct = total ? Math.round(done / total * 100) : 0;
    let t = `Страниц ${done} из ${total} (${pct}%) · прошло ${fmtDur(spent)}`;
    if (final) t += ' · готово';
    else if (avg) {
      const end = new Date(Date.now() + left);
      t += ` · осталось ≈ ${fmtDur(left)} · окончание ≈ ${end.toTimeString().slice(0, 5)}`;
    } else t += ' · оценка времени — после первых страниц';
    $('progressText').textContent = t;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = ([a, b]) => a + Math.random() * (b - a);
  const mode = () => Logic.getMode(settings.mode);

  function setRunningUi(on) {
    $('startBtn').disabled = on;
    $('linksFile').disabled = on;
    $('pickDirBtn').disabled = on;
    $('linksSel').disabled = on;
    document.querySelectorAll('input[name="mode"]').forEach((r) => { r.disabled = on; });
    $('outFormat').disabled = on;
    $('saveScans').disabled = on;
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
      const got = await chrome.storage.local.get(['mode', 'textSel', 'dateSel', 'outFormat', 'saveScans']);
      if (got.mode && Logic.MODES[got.mode]) settings.mode = got.mode;
      settings.textSel = got.textSel || '';
      settings.dateSel = got.dateSel || '';
      settings.outFormat = Logic.MODES[got.outFormat] ? got.outFormat : '';
      settings.saveScans = !!got.saveScans;
    } catch (e) { /* без сохранения — не критично */ }
  }
  async function saveSettings() {
    try { await chrome.storage.local.set(settings); } catch (e) { /* ignore */ }
  }

  function applyModeUi() {
    $('descConfession').textContent = Logic.MODES.confession.description;
    $('descRevision').textContent = Logic.MODES.revision.description;
    document.querySelectorAll('input[name="mode"]').forEach((r) => { r.checked = r.value === settings.mode; });
    applyOutUi();
  }
  // вид результата: по умолчанию как тип обработки, переключатель задаёт его явно
  const outFormat = () => settings.outFormat || settings.mode;
  function applyOutUi() {
    $('outFormat').checked = outFormat() === 'revision';
    $('saveScans').checked = settings.saveScans;
    $('outFormatInfo').textContent = outFormat() === settings.mode
      ? `Excel будет в виде «${Logic.MODES[outFormat()].label}» — как тип обработки.`
      : `Excel будет в виде «${Logic.MODES[outFormat()].label}», хотя данные обрабатываются как «${Logic.MODES[settings.mode].label}».`;
  }
  $('outFormat').addEventListener('change', async () => {
    settings.outFormat = $('outFormat').checked ? 'revision' : 'confession';
    await saveSettings();
    applyOutUi();
    log(`Вид результата в Excel: ${Logic.MODES[outFormat()].label}.`);
  });
  $('saveScans').addEventListener('change', async () => {
    settings.saveScans = $('saveScans').checked;
    await saveSettings();
    log(settings.saveScans ? `Сканы будут сохраняться в папку «${SCAN_DIR}».` : 'Сканы сохраняться не будут.');
  });

  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      settings.mode = r.value;
      settings.outFormat = '';          // при смене типа обработки вид результата снова следует за ним
      await saveSettings();
      applyOutUi();
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
        clearInterval(poll);
        chrome.tabs.onUpdated.removeListener(onUpd);
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => done(new Error('таймаут загрузки страницы')), timeoutMs);
      // подстраховка: событие «загрузка» может прийти раньше подписки — проверяем вкладку раз в секунду
      const want = String(url).replace(/#.*$/, '');
      const started = Date.now();
      let kicks = 0;
      const poll = setInterval(async () => {
        if (finished) { clearInterval(poll); return; }
        try {
          const t = await chrome.tabs.get(tabId);
          if (Date.now() - started > 1500 && t.status === 'complete' && String(t.url || '').replace(/#.*$/, '') === want) done();
          // фоновая вкладка иногда не начинает загрузку («unloaded») — повторяем переход (до двух раз)
          else if (!sawLoading && kicks < 2 && Date.now() - started > 8000 * (kicks + 1) && (t.status === 'unloaded' || t.url !== want)) {
            kicks++;
            chrome.tabs.update(tabId, { url }).catch(() => {});
          } else if (kicks >= 2 && Date.now() - started > 24000 && t.status === 'unloaded') {
            // вкладка так и не загрузилась — закрываем её, следующая попытка откроет новую
            if (tabId === workTabId) workTabId = null;
            chrome.tabs.remove(tabId).catch(() => {});
            done(new Error('рабочая вкладка не загружается — открываю новую'));
          }
        } catch (e) { /* вкладка закрыта — сработает таймаут */ }
      }, 1000);
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
          url, text: res.text || '', date: res.date || '', found: !!res.found, nextNode: res.nextNode || null, tabId,
          origin: res.origin || 'https://ya.ru',
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

  // ------------------------------------------------------ сканы (Scrpt_YA_Orig_Scan)
  // Путь «Главная/Каталог/ЦГА Москвы/Фонд/Опись/Дело/Скан» и имя файла — по данным страницы (без лишних запросов).
  // Скан: в папку «Archive_Scans» рядом с файлом ссылок (уже сохранённые не скачиваются повторно);
  // если выбран только файл ссылок — в «Загрузки/Archive_Scans/». Ссылка из result.xlsx (yaarchive_debug/<время>/) —
  // относительная: ../../Archive_Scans/<файл>.
  function noteMeta(r, n) {
    if (!r || !r.nextNode) return;
    const ci = ExcelSheets.crumbInfo(r.nextNode.crumbs, n, r.nextNode.id, r.origin);
    pageMeta[r.url] = Object.assign(pageMeta[r.url] || {}, { cga: ci.cga, cgaUrl: ci.cgaUrl, scanName: ci.scanName });
  }
  async function getScanDir() {
    if (scanDir || !linksDir) return scanDir;
    try { scanDir = await linksDir.getDirectoryHandle(SCAN_DIR, { create: true }); } catch (e) {
      log(`Не удалось создать папку «${SCAN_DIR}» в ${linksDir.name} (${e.message}) — сканы пойдут в «Загрузки/${SCAN_DIR}/».`);
    }
    return scanDir;
  }
  async function scanExists(name) {
    const d = await getScanDir();
    if (!d) return false;
    try { const f = await (await d.getFileHandle(name)).getFile(); return f.size > 20000; } catch (e) { return false; }
  }
  // -> время, потраченное на скан (мс), чтобы сократить паузу между страницами
  async function saveScan(r, n) {
    const t0 = Date.now();
    const m = pageMeta[r.url];
    if (!m || !r.nextNode || !r.nextNode.id) return 0;
    const setFile = () => Object.assign(m, { scanFile: `${SCAN_DIR}/${m.scanName}`, scanHref: `../../${SCAN_DIR}/${m.scanName}` });
    if (await scanExists(m.scanName)) { scanStats.existed++; setFile(); return 0; }
    let res = null;
    try {
      const [inj] = await chrome.scripting.executeScript({ target: { tabId: r.tabId }, func: PageScripts.scanFetcher, args: [r.nextNode.id, SCAN_QUALITY] });
      res = inj && inj.result;
    } catch (e) { res = { ok: false, err: e.message }; }
    if (!res || !res.ok) {
      scanStats.failed++;
      log(`  стр. ${n}: скан не сохранён — ${(res && res.err) || 'нет ответа'}`);
      return Date.now() - t0;
    }
    const bin = atob(res.b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const d = await getScanDir();
    try {
      if (d) {
        const w = await (await d.getFileHandle(m.scanName, { create: true })).createWritable();
        await w.write(blob); await w.close();
      } else {
        const url = URL.createObjectURL(blob);
        await new Promise((ok) => chrome.downloads.download({ url, filename: `${SCAN_DIR}/${m.scanName}`, conflictAction: 'overwrite', saveAs: false }, () => ok()));
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
      setFile();
      scanStats.saved++; scanStats.bytes += res.size;
      log(`  стр. ${n}: скан ${m.scanName} (${res.w}×${res.h}, ${Math.round(res.origSize / 1024)} КБ → ${Math.round(res.size / 1024)} КБ)`);
    } catch (e) {
      scanStats.failed++;
      log(`  стр. ${n}: скан не записан — ${e.message}`);
    }
    return Date.now() - t0;
  }

  async function ensureLogin() {
    let tabId = await getWorkTab();
    log('Проверяю вход в Яндекс...');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await navigate(tabId, 'https://ya.ru/archive', 60000);
        break;
      } catch (e) {
        log('Страница ya.ru/archive открылась с ошибкой: ' + e.message);
        tabId = await getWorkTab();          // если вкладка была закрыта как незагружающаяся — новая
      }
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
  function buildSheets() {
    return ExcelSheets.build({ processMode: settings.mode, outFormat: outFormat(), families, rowRecords, blockRecords,
      sheetRows, linkRows, pageMeta }, { ConfessionRows, Layout, STYLE: XlsxWriter.STYLE });
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
    pageMeta = {};
    scanDir = null;
    scanStats = { saved: 0, existed: 0, failed: 0, bytes: 0 };
    const m = mode();
    const pageCache = new Map();     // `${fileId}:${page}` -> {url,text,date,found,err}
    let misses = 0;
    setRunningUi(true);
    log(`Тип обработки: ${m.label}. Вид Excel: ${Logic.MODES[outFormat()].label}. Сканы: ${settings.saveScans ? `сохранять в «${SCAN_DIR}»` : 'нет'}. ` +
        `Окно текста: ${settings.textSel || 'авто'}; дата: ${settings.dateSel || 'авто'}.`);
    // всего страниц для шкалы времени (одна страница в нескольких ссылках считается один раз)
    const allPages = new Set();
    for (const it of items) if (it.fileId && it.pFrom !== null) for (let n = it.pFrom; n <= it.pTo; n++) allPages.add(`${it.fileId}:${n}`);
    progressStart(allPages.size);

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
            const tPage = Date.now();
            const r = await fetchSheet(it.fileId, n);
            pageCache.set(key, r);
            noteMeta(r, n);
            // скан сохраняется, пока рабочая вкладка ещё на этой странице; время скана идёт в счёт паузы
            let scanMs = 0;
            if (settings.saveScans && r.nextNode && !stopRequested) scanMs = await saveScan(r, n);
            if (!r.found && !stopRequested) {
              if (++misses >= CFG.MAX_MISSES) {
                stopRequested = true;
                log(`Окно распознанного текста не найдено на ${CFG.MAX_MISSES} страницах подряд — останавливаюсь, ` +
                    'чтобы не собирать лишнее. Нажмите «Указать окно текста вручную» и запустите снова.');
              }
            } else if (r.found) {
              misses = 0;
            }
            if (n < hi) await sleep(Math.max(0, rand(CFG.DELAY) - scanMs));
            progressStep(Date.now() - tPage);
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
      progressShow(true);
      if (settings.saveScans) {
        log(`Сканы: сохранено ${scanStats.saved} (${Math.round(scanStats.bytes / 1048576)} МБ), уже были ${scanStats.existed}, ` +
            `не удалось ${scanStats.failed}. Папка: ${linksDir ? `«${linksDir.name}/${SCAN_DIR}/»` : `«Загрузки/${SCAN_DIR}/»`}.`);
      }
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
