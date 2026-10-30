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

  // -> [{url, where}] — все ссылки с доменами ya.ru и yandex.ru из значений .ged (в порядке следования)
  function gedcomLinks(text) {
    const out = [];
    for (const rec of gedcomRecords(text)) {
      for (const ln of rec.lines) {
        for (const m of ln.value.matchAll(URL_RX)) out.push({ url: cleanUrl(m[0]), where: `${whereOf(rec)} (${ln.tag})` });
      }
    }
    return out;
  }

  // -> [{url, where}] — ссылки из HTML-файла (и из атрибутов href, и из обычного текста)
  function htmlLinks(html) {
    const out = [];
    const s = String(html);
    for (const m of s.matchAll(URL_RX)) out.push({ url: cleanUrl(m[0]), where: 'HTML-файл' });
    return out;
  }

  // ---- одна ссылка -> страницы каталога ----
  // -> {status: 'ok'|'skip', reason, fileId, pages: [n,…]}
  function parseArchiveUrl(url) {
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
      if (hi - lo + 1 > MAX_RANGE) { hi = lo + MAX_RANGE - 1; note = `диапазон обрезан до ${MAX_RANGE} страниц`; }
      const pages = []; for (let n = lo; n <= hi; n++) pages.push(n);
      return { status: 'ok', fileId: id, pages, note };
    }
    return { status: 'skip', reason: 'не страница Яндекс Архива', pages: [] };
  }

  const cleanLink = (fileId, page) => `https://ya.ru/archive/catalog/${fileId}/${page}`;

  // sources: [{url, where}] -> {unique: [{key, fileId, page, clean, origs[], wheres[]}], entries: [{url, where, status, clean, pages}]}
  // Дубликат — та же страница (fileId + номер) независимо от «?center=», домена (ya.ru/yandex.ru) и прочих параметров.
  function buildPlan(sources) {
    const unique = [], index = new Map(), entries = [];
    const seenUrl = new Set();
    for (const s of sources) {
      const url = s.url, p = parseArchiveUrl(url);
      const e = { url, where: s.where || '', status: '', clean: '', pages: p.pages.length };
      entries.push(e);
      if (p.status !== 'ok') { e.status = 'пропущена: ' + p.reason; continue; }
      let fresh = 0;
      for (const n of p.pages) {
        const key = `${p.fileId}:${n}`;
        let u = index.get(key);
        if (!u) {
          u = { key, fileId: p.fileId, page: n, clean: cleanLink(p.fileId, n), origs: [], wheres: [] };
          index.set(key, u); unique.push(u); fresh++;
        }
        if (!u.origs.includes(url)) u.origs.push(url);
        if (s.where && !u.wheres.includes(s.where)) u.wheres.push(s.where);
      }
      e.clean = p.pages.length === 1 ? cleanLink(p.fileId, p.pages[0]) : `${cleanLink(p.fileId, p.pages[0])} … ${p.pages[p.pages.length - 1]}`;
      if (!fresh) e.status = seenUrl.has(url) ? 'дубликат (та же ссылка)' : 'дубликат (страница уже в списке)';
      else e.status = (p.pages.length > 1 ? `диапазон: ${p.pages.length} стр.` : 'страница') + (p.note ? `; ${p.note}` : '') + (fresh < p.pages.length ? `; новых ${fresh}` : '');
      seenUrl.add(url);
    }
    return { unique, entries };
  }

  // Исправленный HTML-файл ссылок: по одной очищенной ссылке на страницу, без дубликатов и без «?center=»
  function fixedHtml(plan) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const rows = plan.unique.map((u) => `<p><a href="${esc(u.clean)}">${esc(u.clean)}</a></p>`);
    return '<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><title>Список ссылок (исправленный)</title></head><body>\n' +
      `<p>Страниц без повторов: ${plan.unique.length}</p>\n` + rows.join('\n') + '\n</body></html>\n';
  }

  // Строки листов Excel. meta[clean] = {cga, scanFile, scanHref, scanName, err}
  const HEAD_MAIN = ['Исходная ссылка', 'Локальная Ссылка на страницу', 'Ссылка на ЦГА Москвы'];
  const HEAD_ALL = ['Исходная ссылка', 'Ссылка для скачивания', 'Статус', 'Где найдена'];
  function sheets(plan, meta) {
    const main = [HEAD_MAIN], mainLinks = [];
    plan.unique.forEach((u) => {
      const m = meta[u.clean] || {};
      const r = main.length;
      main.push([u.origs[0], m.scanFile ? m.scanName || m.scanFile : (m.err ? `не скачан: ${m.err}` : ''), m.cga || '']);
      if (/^https?:/.test(u.origs[0])) mainLinks.push([r, 0, u.origs[0]]);
      if (m.scanFile) mainLinks.push([r, 1, m.scanHref || m.scanFile]);
    });
    const all = [HEAD_ALL];
    plan.entries.forEach((e) => all.push([e.url, e.clean, e.status, e.where]));
    const w = (rows, cap) => rows[0].map((_, c) => Math.min(cap, Math.max(12, ...rows.slice(0, 200).map((r) => String(r[c] || '').length)) + 2));
    return [
      { name: 'Страницы', rows: main, widths: [70, 46, 42], links: mainLinks },
      { name: 'Все ссылки', rows: all, widths: w(all, 70) },
    ];
  }

  const api = { decodeBytes, gedcomRecords, gedcomLinks, htmlLinks, parseArchiveUrl, cleanLink, buildPlan, fixedHtml, sheets, HEAD_MAIN, HEAD_ALL, MAX_RANGE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LinksTools = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
