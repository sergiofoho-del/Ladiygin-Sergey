// Раздел «Скачать графические образы страниц по списку ссылок»: разбор ссылок из HTML и из GEDCOM,
// приведение к ссылке на страницу каталога, удаление дубликатов. Без обращения к сети и к DOM — проверяется в Node.
(function (root) {
  const MAX_RANGE = 500;      // страниц в одной ссылке-диапазоне (защита от опечатки)
  const URL_RX = /https?:\/\/(?:[\w-]+\.)*(?:ya\.ru|yandex\.ru)(?![\w.-])[^\s"'<>\\^`{}|]*/gi;
  const ID_RX = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

  // ---- чтение байтов файла: UTF-8 / UTF-16 (с BOM и без) / windows-1251 ----
  function decodeBytes(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
    if (b.length >= 4 && b[0] === 0x30 && b[1] === 0 && b[2] !== 0) return new TextDecoder('utf-16le').decode(b);
    if (b.length >= 4 && b[0] === 0 && b[1] === 0x30) return new TextDecoder('utf-16be').decode(b);
    const s = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(s); } catch (e) { /* не UTF-8 */ }
    try { return new TextDecoder('windows-1251').decode(s); } catch (e) { return new TextDecoder('utf-8').decode(s); }
  }

  // Все ссылки архива из значения: слипшиеся («…/7;https://…/278;» без пробела, «…/7https://…») делятся по началу следующей ссылки
  function urlsIn(value) {
    const out = [];
    for (const m of String(value).matchAll(URL_RX)) {
      for (const piece of m[0].split(/(?=https?:\/\/)/i)) {
        const mm = piece.match(new RegExp('^' + URL_RX.source, 'i'));
        if (mm) out.push(cleanUrl(mm[0]));
      }
    }
    return out;
  }
  const cleanUrl = (u) => String(u).replace(/&amp;/gi, '&').replace(/&#38;/g, '&').replace(/[)\].,;:!?»”…]+$/u, '');

  // ---- GEDCOM: строки уровень [@id@] тег [значение]; CONC дописывает значение без разделителя, CONT — с новой строки ----
  function gedcomRecords(text) {
    const lines = String(text).replace(/^﻿/, '').split(/\r\n|\n|\r/);
    const recs = [];
    let rec = null, last = null;
    for (const raw of lines) {
      const m = raw.match(/^\s*(\d+)\s+(?:(@[^@]+@)\s+)?([A-Za-z_0-9]+)(?:[ \t](.*))?$/);
      if (!m) { if (last && raw.trim()) last.value += raw; continue; }
      const level = parseInt(m[1], 10), xref = m[2] || '', tag = m[3].toUpperCase(), value = m[4] === undefined ? '' : m[4];
      if (level === 0) {
        rec = { xref, tag, name: '', lines: [] };
        recs.push(rec); last = null;
        if (value) { last = { level: 0, tag, value }; rec.lines.push(last); }   // значение в самой строке записи (0 @N1@ NOTE текст)
        continue;
      }
      if (!rec) continue;
      if (tag === 'CONC' && last) { last.value += value; continue; }
      if (tag === 'CONT' && last) { last.value += '\n' + value; continue; }
      last = { level, tag, value };
      rec.lines.push(last);
      if (tag === 'NAME' && level === 1 && !rec.name) rec.name = value.replace(/\//g, ' ').replace(/\s+/g, ' ').trim();
    }
    return recs;
  }
  const whereOf = (rec) => [rec.tag, rec.xref, rec.name && '— ' + rec.name].filter(Boolean).join(' ');

  // Персона, к которой относится запись: INDI — её имя; FAM — супруги (HUSB/WIFE); SOUR/NOTE/OBJE — персоны, которые на них ссылаются
  function personsOf(recs) {
    const byX = new Map(recs.filter((r) => r.xref).map((r) => [r.xref, r]));
    const nameOf = (r) => r.name || (r.tag === 'INDI' ? r.xref : '');
    const cited = new Map();
    const cite = (ptr, who) => { if (!who) return; const a = cited.get(ptr) || []; if (!a.includes(who)) a.push(who); cited.set(ptr, a); };
    for (const r of recs) {
      if (r.tag !== 'INDI' && r.tag !== 'FAM') continue;
      const who = r.tag === 'INDI' ? nameOf(r) : famNames(r);
      for (const ln of r.lines) if (/^@[^@]+@$/.test(ln.value.trim()) && /^(SOUR|NOTE|OBJE)$/.test(ln.tag)) cite(ln.value.trim(), who);
    }
    function famNames(r) {
      return r.lines.filter((ln) => /^(HUSB|WIFE)$/.test(ln.tag)).map((ln) => byX.get(ln.value.trim())).filter(Boolean).map(nameOf).filter(Boolean).join(' и ');
    }
    return (r) => (r.tag === 'INDI' ? nameOf(r) : r.tag === 'FAM' ? famNames(r) : (cited.get(r.xref) || []).join('; '));
  }

  // Номера (xref) персон INDI, к которым относится запись: INDI — она сама; FAM — супруги; SOUR/NOTE/OBJE — те, кто на них ссылается
  function xrefsOf(recs) {
    const byX = new Map(recs.filter((r) => r.xref).map((r) => [r.xref, r]));
    const cited = new Map();
    const add = (ptr, x) => { const a = cited.get(ptr) || []; if (!a.includes(x)) a.push(x); cited.set(ptr, a); };
    const own = (r) => (r.tag === 'INDI' ? [r.xref] : r.tag === 'FAM'
      ? r.lines.filter((ln) => /^(HUSB|WIFE)$/.test(ln.tag)).map((ln) => ln.value.trim()).filter((x) => byX.get(x) && byX.get(x).tag === 'INDI') : []);
    for (const r of recs) {
      if (r.tag !== 'INDI' && r.tag !== 'FAM') continue;
      for (const ln of r.lines) if (/^@[^@]+@$/.test(ln.value.trim()) && /^(SOUR|NOTE|OBJE)$/.test(ln.tag)) own(r).forEach((x) => add(ln.value.trim(), x));
    }
    return (r) => (r.tag === 'INDI' || r.tag === 'FAM' ? own(r) : (cited.get(r.xref) || []));
  }

  // -> [{url, where, person, xrefs}] — все ссылки с доменами ya.ru и yandex.ru из значений .ged (в порядке следования)
  function gedcomLinks(text) {
    const out = [];
    const recs = gedcomRecords(text);
    const personOf = personsOf(recs), xrefOf = xrefsOf(recs);
    for (const rec of recs) {
      const person = personOf(rec), xrefs = xrefOf(rec);
      for (const ln of rec.lines) {
        for (const url of urlsIn(ln.value)) out.push({ url, where: `${whereOf(rec)} (${ln.tag})`, person, xrefs });
      }
    }
    return out;
  }

  // -> [{url, where}] — ссылки из HTML-файла (и из атрибутов href, и из обычного текста)
  function htmlLinks(html) {
    const out = [];
    const s = String(html);
    for (const url of urlsIn(s)) out.push({ url, where: 'HTML-файл' });
    return out;
  }

  // ---- одна ссылка -> страницы каталога ----
  // -> {status: 'ok'|'skip', reason, fileId, pages: [n,…]}
  // opts.expandRange — ссылка поиска со страницами «от…до» разворачивается в диапазон; по умолчанию берётся только страница, на которую указывает ссылка
  function parseArchiveUrl(url, opts) {
    let u;
    try { u = new URL(url); } catch (e) { return { status: 'skip', reason: 'не удалось разобрать ссылку', pages: [] }; }
    const h = u.hostname.toLowerCase();
    if (!/(^|\.)(ya\.ru|yandex\.ru)$/.test(h)) return { status: 'skip', reason: 'не ya.ru / yandex.ru', pages: [] };
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'archive') return { status: 'skip', reason: 'не страница Яндекс Архива', pages: [] };
    const num = (v) => { const n = parseInt(v, 10); return /^\d+$/.test(String(v || '').trim()) && n > 0 ? n : null; };
    if (parts[1] === 'catalog') {
      const id = parts[2] || '';
      if (!ID_RX.test(id)) return { status: 'skip', reason: 'в ссылке нет идентификатора дела', pages: [] };
      const p = num(parts[3]);
      if (p === null) return { status: 'skip', reason: 'в ссылке нет номера страницы (это дело/опись целиком)', fileId: id, pages: [] };
      return { status: 'ok', fileId: id, pages: [p] };
    }
    if (parts[1] === 'search') {
      const id = u.searchParams.get('fileId') || '';
      if (!ID_RX.test(id)) return { status: 'skip', reason: 'в ссылке поиска нет fileId', pages: [] };
      const a = num(u.searchParams.get('sheet_page_from')), b0 = num(u.searchParams.get('sheet_page_to'));
      if (a === null) return { status: 'skip', reason: 'в ссылке поиска нет номера страницы', fileId: id, pages: [] };
      let lo = a, hi = b0 === null ? a : b0;
      if (lo > hi) [lo, hi] = [hi, lo];
      let note = '';
      if (!(opts && opts.expandRange) && hi > lo) { note = `в ссылке поиска страницы ${lo}–${hi}: взята только страница ${a}`; hi = lo = a; }
      if (hi - lo + 1 > MAX_RANGE) { hi = lo + MAX_RANGE - 1; note = `диапазон обрезан до ${MAX_RANGE} страниц`; }
      const pages = []; for (let n = lo; n <= hi; n++) pages.push(n);
      return { status: 'ok', fileId: id, pages, note };
    }
    return { status: 'skip', reason: 'не страница Яндекс Архива', pages: [] };
  }

  const cleanLink = (fileId, page) => `https://ya.ru/archive/catalog/${fileId}/${page}`;

  // sources: [{url, where}] -> {unique: [{key, fileId, page, clean, origs[], wheres[]}], entries: [{url, where, status, clean, pages}]}
  // Дубликат — та же страница (fileId + номер) независимо от «?center=», домена (ya.ru/yandex.ru) и прочих параметров.
  function buildPlan(sources, opts) {
    const unique = [], index = new Map(), entries = [];
    const seenUrl = new Set();
    for (const s of sources) {
      const url = s.url, p = parseArchiveUrl(url, opts);
      const e = { url, where: s.where || '', person: s.person || '', status: '', clean: '', pages: p.pages.length };
      entries.push(e);
      if (p.status !== 'ok') { e.status = 'пропущена: ' + p.reason; continue; }
      let fresh = 0;
      for (const n of p.pages) {
        const key = `${p.fileId}:${n}`;
        let u = index.get(key);
        if (!u) {
          u = { key, fileId: p.fileId, page: n, clean: cleanLink(p.fileId, n), origs: [], wheres: [], persons: [], xrefs: [] };
          index.set(key, u); unique.push(u); fresh++;
        }
        if (!u.origs.includes(url)) u.origs.push(url);
        if (s.where && !u.wheres.includes(s.where)) u.wheres.push(s.where);
        if (s.person && !u.persons.includes(s.person)) u.persons.push(s.person);
        (s.xrefs || []).forEach((x) => { if (!u.xrefs.includes(x)) u.xrefs.push(x); });
      }
      e.clean = p.pages.length === 1 ? cleanLink(p.fileId, p.pages[0]) : `${cleanLink(p.fileId, p.pages[0])} … ${p.pages[p.pages.length - 1]}`;
      if (!fresh) e.status = seenUrl.has(url) ? 'дубликат (та же ссылка)' : 'дубликат (страница уже в списке)';
      else e.status = (p.pages.length > 1 ? `диапазон: ${p.pages.length} стр.` : 'страница') + (p.note ? `; ${p.note}` : '') + (fresh < p.pages.length ? `; новых ${fresh}` : '');
      seenUrl.add(url);
    }
    return { unique, entries, gedcom: sources.some((x) => 'person' in x) };
  }

  // Исправленный HTML-файл ссылок: по одной очищенной ссылке на страницу, без дубликатов и без «?center=»
  function fixedHtml(plan) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const rows = plan.unique.map((u) => `<p><a href="${esc(u.clean)}">${esc(u.clean)}</a></p>`);
    return '<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><title>Список ссылок (исправленный)</title></head><body>\n' +
      `<p>Страниц без повторов: ${plan.unique.length}</p>\n` + rows.join('\n') + '\n</body></html>\n';
  }

  // Строки листов Excel. meta[clean] = {cga, docType, scanFile, scanHref, scanName, err}
  // Для GEDCOM добавляется первый столбец «Имя персоны» (к какой персоне относится ссылка).
  const HEAD_MAIN = ['Ссылка на страницу', 'Локальная Ссылка на страницу', 'Архив хранения документа', 'Тип документа'];
  const HEAD_ALL = ['Ссылка на страницу', 'Ссылка для скачивания', 'Статус', 'Где найдена'];
  function sheets(plan, meta) {
    const g = !!plan.gedcom, o = g ? 1 : 0;
    const main = [(g ? ['Имя персоны'] : []).concat(HEAD_MAIN)], mainLinks = [];
    plan.unique.forEach((u) => {
      const m = meta[u.clean] || {};
      const r = main.length;
      const row = [u.origs[0], m.scanFile ? m.scanLocal || m.scanName || m.scanFile : (m.err ? `не скачан: ${m.err}` : ''), m.cga || '', m.docType || ''];
      main.push(g ? [(u.persons || []).join('; ')].concat(row) : row);
      if (/^https?:/.test(u.origs[0])) mainLinks.push([r, o, u.origs[0]]);
      if (m.scanFile) mainLinks.push([r, o + 1, m.scanHref || m.scanFile]);
    });
    const all = [g ? ['Имя персоны'].concat(HEAD_ALL) : HEAD_ALL];
    plan.entries.forEach((e) => all.push(g ? [e.person || ''].concat([e.url, e.clean, e.status, e.where]) : [e.url, e.clean, e.status, e.where]));
    const w = (rows, cap) => rows[0].map((_, c) => Math.min(cap, Math.max(12, ...rows.slice(0, 200).map((r) => String(r[c] || '').length)) + 2));
    return [
      { name: 'Страницы', rows: main, widths: (g ? [28] : []).concat([70, 46, 42, 38]), links: mainLinks },
      { name: 'Все ссылки', rows: all, widths: w(all, 70) },
    ];
  }

  const api = { decodeBytes, gedcomRecords, gedcomLinks, htmlLinks, parseArchiveUrl, cleanLink, buildPlan, fixedHtml, sheets, HEAD_MAIN, HEAD_ALL, MAX_RANGE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LinksTools = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
