// Листы Excel результата — общий модуль для расширения (app.js) и пересборки из отладочного пакета
// (tools/rebuild_from_debug.js), чтобы оба давали один и тот же файл.
//
// Вид результата выбирается отдельно от типа обработки (outFormat):
//   'confession' — «Исповедные ведомости»: одна строка = один человек (Год | НП | Двор | Человек | Пол | Номер |
//                  Возраст | Год рождения | Примечание | ссылки);
//   'revision'   — «Ревизские сказки»: одна строка = семья-двор, люди двора в одной ячейке, плюс лист «Строки».
// Данные, собранные в режиме ревизских сказок, можно выдать в виде исповедных ведомостей и наоборот:
// строки приводятся к виду «один человек» (текст блока делится по людям) или «строка таблицы».
//
// Ссылки (лист «Люди» и «Страницы»):
//   «Ссылка на страницу» — одинаковые подряд идущие ссылки сливаются в одну ячейку (с другими не смешиваются);
//   «Локальная Ссылка на страницу» — относительная ссылка на сохранённый скан (папка Archive_Scans);
//   «Ссылка на ЦГА Москвы» — путь из шапки страницы «Главная/Каталог/ЦГА Москвы/Фонд …/Опись …/Дело …/Скан …»,
//   ячейка ведёт на дело в каталоге архива.
(function (root) {
  'use strict';

  const trunc = (v) => (typeof v === 'string' ? v.slice(0, 32000) : v === null || v === undefined ? '' : v);

  function widthsFor(rows) {
    const cols = Math.max(...rows.map((r) => r.length));
    const out = [];
    for (let c = 0; c < cols; c++) {
      let w = 8;
      rows.slice(0, 200).forEach((r) => { const v = r[c]; if (v !== '' && v !== null && v !== undefined) w = Math.max(w, String(v).length); });
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
  // год рождения = год документа − полных лет (±1 год)
  function birthYear(year, age) {
    const v = ageValue(age), y = parseInt(year, 10);
    return v === null || !y ? '' : y - Math.floor(v);
  }
  const cleanAge = (a) => String(a || '').replace(/[.,\s]+$/, '').trim();

  // ---------------------------------------------------------------- приведение строк
  // Строки ревизской сказки (строка таблицы блока) -> люди: текст блока делится по людям по полу строк.
  function revisionToPersons(rows, splitBlock) {
    const out = [];
    let i = 0;
    while (i < rows.length) {
      const r0 = rows[i];
      let j = i;
      while (j < rows.length && rows[j].url === r0.url && rows[j].sex === r0.sex && rows[j].blockNo === r0.blockNo && rows[j].names === r0.names) j++;
      const grp = rows.slice(i, j);
      const parts = splitBlock ? splitBlock(r0.names || '', grp.map((r) => (r.sex === 'ж' ? 'F' : 'M'))) : grp.map(() => ['', '']);
      grp.forEach((r, k) => {
        const notes = (r.notes || []).slice();
        const now = cleanAge(r.ageNow), prev = cleanAge(r.agePrev);
        let age = now;
        if (!age && prev) { age = prev; notes.push('возраст по прошлой ревизии'); }
        if (r.departed) notes.push('выбыл: ' + cleanAge(r.departed));
        if (r.absent) notes.push('в отлучке: ' + cleanAge(r.absent));
        if (parts[k] && parts[k][1]) notes.push(parts[k][1]);
        out.push({ year: r.year, page: r.page, url: r.url, settlement: r.settlement, yard: r.yard, sex: r.sex, no: '',
          age, person: (parts[k] && parts[k][0]) || '', names: r.names, notes, flags: r.flags || '' });
      });
      i = j;
    }
    return out;
  }

  // Люди исповедной ведомости -> строки вида «Строки» ревизской сказки
  function personsToRevisionRows(rows) {
    return rows.map((r) => ({ year: r.year, settlement: r.settlement, yard: r.yard, sex: r.sex, blockNo: r.half || '',
      rowNo: r.no, rowsInBlock: r.inBlock, names: r.person || r.names, agePrev: '', departed: '', absent: '', ageNow: r.age,
      flags: [r.flags, (r.notes || []).join('; ')].filter(Boolean).join('; '), url: r.url, page: r.page }));
  }

  // ---------------------------------------------------------------- ссылки
  const LINK_HEAD = ['Ссылка на страницу', 'Локальная Ссылка на страницу', 'Ссылка на ЦГА Москвы'];

  // три ячейки ссылок строки по адресу страницы
  function linkCells(url, meta) {
    const m = (meta && url && meta[url]) || {};
    return [url || '', m.scanFile ? m.scanName || m.scanFile : '', m.cga || ''];
  }

  // слияние подряд идущих одинаковых ссылок (в пределах года) и гиперссылки
  function linkLayout(rows, firstCol, meta, yearCol) {
    const merges = [], links = [];
    let st = 1;
    const key = (r) => `${rows[r][yearCol]}|${rows[r][firstCol]}`;
    const flush = (a, b) => {
      const url = rows[a][firstCol];
      if (!url) return;
      const m = meta[url] || {};
      if (b > a) for (let c = 0; c < 3; c++) merges.push([a, firstCol + c, b, firstCol + c]);
      for (let r = a + 1; r <= b; r++) for (let c = 0; c < 3; c++) rows[r][firstCol + c] = '';
      if (/^https?:/.test(url)) links.push([a, firstCol, url]);
      if (m.scanFile) links.push([a, firstCol + 1, m.scanHref || encodeURI(m.scanFile)]);
      if (m.cga && m.cgaUrl) links.push([a, firstCol + 2, m.cgaUrl]);
    };
    for (let r = 2; r <= rows.length; r++) {
      if (r === rows.length || key(r) !== key(st)) { flush(st, r - 1); st = r; }
    }
    const linkCols = new Set([firstCol, firstCol + 1, firstCol + 2]);
    return { merges, links, linkCols };
  }

  // ---------------------------------------------------------------- листы
  function build(d, deps) {
    const { ConfessionRows, Layout, STYLE } = deps;
    const meta = d.pageMeta || {};
    const outFormat = d.outFormat || d.processMode;

    const pageRows = [['Год', 'Найденные НП округи', ...LINK_HEAD, 'Распознанный текст страницы', 'Проверка страницы']];
    (d.sheetRows || []).forEach((r) => pageRows.push([r.year, r.found, ...linkCells(r.url, meta), r.text, r.check || ''].map(trunc)));
    const pageLinks = [];
    pageRows.forEach((row, i) => {
      if (!i) return;
      const m = meta[row[2]] || {};
      if (/^https?:/.test(row[2])) pageLinks.push([i, 2, row[2]]);
      if (m.scanFile) pageLinks.push([i, 3, m.scanHref || encodeURI(m.scanFile)]);
      if (m.cga && m.cgaUrl) pageLinks.push([i, 4, m.cgaUrl]);
    });
    const pgw = widthsFor(pageRows); pgw[5] = 60;
    const linkOut = [['Год', 'Исходная ссылка', 'Диапазон из ссылки', 'Просмотрено страниц', 'Найдено НП (шт.)', 'Какие НП', 'Решение',
      'Дворов (семей)', 'Людей', 'Как собрано', 'Примечание']];
    (d.linkRows || []).forEach((r) => linkOut.push(r.map(trunc)));
    const tail = [
      { name: 'Страницы', rows: pageRows, widths: pgw, links: pageLinks },
      { name: 'Ссылки', rows: linkOut, widths: widthsFor(linkOut) },
    ];

    if (outFormat === 'confession') {
      const recs = d.processMode === 'revision' ? revisionToPersons(d.rowRecords || [], ConfessionRows.splitBlock) : (d.rowRecords || []);
      const head = ['Год', 'Населённый пункт', 'Двор №', 'Человек (как распознано)', 'Пол', 'Номер', 'Возраст', 'Год рождения',
        'Примечание', ...LINK_HEAD];
      const people = [head];
      const yards = ConfessionRows.fillYards(recs);
      recs.forEach((r, i) => {
        const yd = yards[i];
        let notes = (r.notes || []).slice();
        if (yd.calc) {
          notes = notes.filter((n) => !/^номер двора не найден/.test(n));
          if (i === 0 || !yards[i - 1].calc || yards[i - 1].yard !== yd.yard) notes.unshift(`номер двора ${yd.yard} вычислен по соседним дворам`);
        }
        people.push([r.year, r.settlement, yd.yard, r.person, r.sex,
          r.no === '' ? '' : (parseInt(r.no, 10) || r.no), r.age === '' ? '' : (/^\d+$/.test(String(r.age)) ? parseInt(r.age, 10) : r.age),
          birthYear(r.year, r.age), notes.join('; '), ...linkCells(r.url, meta)].map(trunc));
      });
      const merges = [];
      const runs = (col, key) => {
        let s = 1;
        for (let r = 2; r <= people.length; r++) {
          if (r === people.length || key(r) !== key(s)) { if (r - 1 > s) merges.push([s, col, r - 1, col]); s = r; }
        }
      };
      runs(1, (r) => `${people[r][0]}|${people[r][1]}`);
      runs(2, (r) => (people[r][2] === '' || people[r][2] == null) ? `empty${r}` : `${people[r][0]}|${people[r][1]}|${people[r][2]}|${yards[r - 1].calc}`);
      const L = linkLayout(people, 9, meta, 0);
      const styleAt = (r, c) => (c === 1 ? STYLE.SETTLEMENT : c === 2 ? (yards[r - 1] && yards[r - 1].calc ? STYLE.YARD_CALC : STYLE.YARD)
        : c === 3 ? STYLE.PERSON : L.linkCols.has(c) ? STYLE.LINK : undefined);
      const pw = widthsFor(people); pw[1] = 9; pw[2] = 7; pw[3] = 45; pw[8] = 40; pw[9] = 40; pw[10] = 30; pw[11] = 40;
      const blocks = [['Год', 'Населённый пункт', 'Двор №', 'Текст блока целиком (как распознан)', 'Людей в блоке', 'Ссылка на страницу']];
      (d.blockRecords || []).forEach((b) => blocks.push([b.year, b.settlement, b.yard, b.text, b.persons, b.url].map(trunc)));
      const bw = widthsFor(blocks); bw[3] = 70;
      return [
        { name: 'Люди', rows: people, widths: pw, styleAt, merges: merges.concat(L.merges), links: L.links },
        { name: 'Блоки текста', rows: blocks, widths: bw },
        ...tail,
      ];
    }

    // вид «Ревизские сказки»: одна строка = семья-двор
    const peopleRows = [['Год', 'Населённый пункт', 'Двор №', 'Люди двора (№ м/ж, как распознано, возраст)', 'Примечание', ...LINK_HEAD]];
    (d.families || []).forEach((f) => peopleRows.push([f.year, f.settlement, f.yard, Layout.familyCell(f), f.notes.join('; '),
      ...linkCells(f.url, meta)].map(trunc)));
    const L = linkLayout(peopleRows, 5, meta, 0);
    const pw = widthsFor(peopleRows); pw[3] = 60; pw[5] = 40; pw[6] = 30; pw[7] = 40;
    const rr = d.processMode === 'confession' ? personsToRevisionRows(d.rowRecords || []) : (d.rowRecords || []);
    const detail = [['Год', 'Населённый пункт', 'Двор №', 'Пол', 'Блок №', 'Строка №', 'Строк в блоке', 'Текст блока (список людей)',
      'Лѣта по ревизии', 'Когда выбыл', 'В отлучке с', 'Лѣта нынѣ', 'Проверка', 'Ссылка на страницу']];
    rr.forEach((r) => detail.push([r.year, r.settlement, r.yard, r.sex, r.blockNo, r.rowNo, r.rowsInBlock, r.names,
      r.agePrev, r.departed, r.absent, r.ageNow, r.flags, r.url].map(trunc)));
    const sheets = [{ name: 'Люди', rows: peopleRows, widths: pw, merges: L.merges, links: L.links,
      styleAt: (r, c) => (L.linkCols.has(c) ? STYLE.LINK : c === 3 ? STYLE.WRAP : undefined) }];
    if (rr.length) { const dw = widthsFor(detail); dw[7] = 50; sheets.push({ name: 'Строки', rows: detail, widths: dw }); }
    return sheets.concat(tail);
  }

  // ---------------------------------------------------------------- сведения о странице
  // Путь из шапки страницы и имя файла скана — по breadcrumbs данных страницы (как в Scrpt_YA_Orig_Scan).
  const sanitize = (v) => String(v || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  function crumbInfo(crumbs, page, nodeId, origin) {
    const find = (t) => (crumbs || []).find((c) => c.type === t) || null;
    const archive = find('Archive'), fund = find('Fund'), inv = find('Inventory'), file = find('File');
    const num = (c) => { const m = c && String(c.code || '').match(/\d+[а-яА-Яa-zA-Z]?/); return m ? m[0] : ''; };
    const parts = ['Главная', 'Каталог'];
    if (archive) parts.push(archive.name || archive.code);
    if (fund) parts.push('Фонд ' + (fund.code || ''));
    if (inv) parts.push('Опись ' + num(inv));
    if (file) parts.push('Дело ' + (file.code || ''));
    if (page !== undefined && page !== null) parts.push('Скан ' + page);
    const base = origin || 'https://ya.ru';
    const cgaUrl = file ? `${base}/archive/catalog/${file.id}` : archive ? `${base}/archive/catalog/${archive.id}` : '';
    const padded = String(page).padStart(4, '0');
    const codes = [fund && fund.code ? String(fund.code).trim() : '', num(inv), file && file.code ? String(file.code).trim() : ''].filter(Boolean);
    const scanName = codes.length >= 2
      ? (archive && archive.name ? sanitize(archive.name) + '_[ЯА]_' : '') + sanitize(codes.join('-') + '-' + padded) + '.jpg'
      : 'YA_archive_' + sanitize(nodeId) + '_' + padded + '.jpg';
    return { cga: (crumbs && crumbs.length) ? parts.join('/') : '', cgaUrl, scanName };
  }

  const api = { build, crumbInfo, revisionToPersons, personsToRevisionRows, birthYear, widthsFor, LINK_HEAD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ExcelSheets = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
