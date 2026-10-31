// Навык «Запись в GEDCOM»: вносит в .ged-файл ссылки на сохранённые сканы страниц Яндекс Архива.
// Без обращения к сети и к DOM — проверяется в Node (tests/run_gedcom_writer.js).
//
// Входные данные: исходный текст .ged; план ссылок (LinksTools.buildPlan — у каждой страницы u.xrefs, номера персон INDI);
// meta[u.clean] = {scanLocal|scanFile, scanName, cga, docType} из результата скачивания.
// Вариант 'source' — «Источник»: запись SOUR (название, архив хранения, ссылка, файл скана OBJE) + у персоны ссылка SOUR с PAGE.
// Вариант 'media'  — «Общий медиа-объект»: запись 0 OBJE (FILE, FORM, TITL, NOTE) + у персоны ссылка OBJE на неё; одна страница на нескольких людей = один объект.
// Свои записи помечены номерами @YA_S1@, @YA_M1@…: повторный запуск сначала убирает прежние, дублей не будет.
(function (root) {
  const OWN_RX = /^@YA_[SM]\d+@$/;
  const PREFIX = { source: 'YA_S', media: 'YA_M' };

  // строка GEDCOM: длинное значение режется на CONC (по 200 символов), переводы строк — CONT
  function emit(out, level, tag, value) {
    const parts = String(value === undefined ? '' : value).split(/\r\n|\n|\r/);
    parts.forEach((part, i) => {
      const chars = Array.from(part);
      const first = chars.slice(0, 200).join('');
      out.push((i ? `${level + 1} CONT` : `${level} ${tag}`) + (first ? ' ' + first : ''));
      for (let p = 200; p < chars.length; p += 200) out.push(`${level + 1} CONC ${chars.slice(p, p + 200).join('')}`);
    });
  }

  function splitRecords(text) {
    const lines = String(text).replace(/^﻿/, '').split(/\r\n|\n|\r/);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const recs = [];
    let rec = null;
    for (const raw of lines) {
      const m = raw.match(/^\s*0\s+(?:(@[^@]+@)\s+)?([A-Za-z_0-9]+)/);
      if (m) { rec = { xref: m[1] || '', tag: m[2].toUpperCase(), lines: [raw] }; recs.push(rec); }
      else if (rec) rec.lines.push(raw);
      else { rec = { xref: '', tag: '', lines: [raw] }; recs.push(rec); }
    }
    return recs;
  }

  // убирает записи и ссылки, добавленные этим навыком раньше; -> число убранных строк-ссылок и записей
  function stripOwn(recs) {
    let removed = 0;
    const kept = recs.filter((r) => { if (OWN_RX.test(r.xref)) { removed++; return false; } return true; });
    for (const r of kept) {
      const out = [];
      let skipLevel = null;
      for (const ln of r.lines) {
        const m = ln.match(/^\s*(\d+)\s+(?:@[^@]+@\s+)?([A-Za-z_0-9]+)(?:[ \t](.*))?$/);
        const level = m ? parseInt(m[1], 10) : -1;
        if (skipLevel !== null) { if (m && level > skipLevel) continue; skipLevel = null; }
        if (m && level > 0 && /^(SOUR|OBJE)$/i.test(m[2]) && OWN_RX.test((m[3] || '').trim())) { skipLevel = level; removed++; continue; }
        out.push(ln);
      }
      r.lines = out;
    }
    return { recs: kept, removed };
  }

  const fmtOf = (path) => { const m = String(path).match(/\.([A-Za-z0-9]{2,4})$/); return m ? m[1].toLowerCase() : 'jpg'; };

  function apply(text, plan, meta, variant, opts) {
    if (variant !== 'source' && variant !== 'media') throw new Error('Вариант записи: source или media');
    const o = opts || {};
    const eol = /\r\n/.test(text) ? '\r\n' : /\n/.test(text) ? '\n' : /\r/.test(text) ? '\r' : '\r\n';
    const base = stripOwn(splitRecords(text));
    const recs = base.recs;
    const indi = new Map(recs.filter((r) => r.tag === 'INDI' && r.xref).map((r) => [r.xref, r]));
    const stats = { variant, pages: 0, links: 0, persons: new Set(), noScan: 0, noPerson: 0, removed: base.removed };
    const added = [];
    let n = 0;
    for (const u of plan.unique) {
      const m = (meta && meta[u.clean]) || {};
      const path = m.scanLocal || m.scanFile || '';
      if (!path || m.err) { stats.noScan++; continue; }
      const who = (u.xrefs || []).filter((x) => indi.has(x));
      if (!who.length) { stats.noPerson++; continue; }
      const id = `@${PREFIX[variant]}${++n}@`;
      const docType = m.docType || 'Страница документа Яндекс Архива';
      const where = `Скан ${u.page}, ${u.clean}`;
      const rec = [`0 ${id} ${variant === 'source' ? 'SOUR' : 'OBJE'}`];
      if (variant === 'source') {
        emit(rec, 1, 'TITL', docType);
        if (m.cga) emit(rec, 1, 'PUBL', `Архив хранения документа: ${m.cga}`);
        emit(rec, 1, 'NOTE', `Страница в Яндекс Архиве: ${u.clean}`);
        rec.push('1 OBJE');
        emit(rec, 2, 'FILE', path); emit(rec, 2, 'FORM', fmtOf(path));
        emit(rec, 2, 'TITL', m.scanName ? `${docType}, ${m.scanName}` : docType);
      } else {
        emit(rec, 1, 'FILE', path); emit(rec, 1, 'FORM', fmtOf(path));
        emit(rec, 1, 'TITL', docType);
        emit(rec, 1, 'NOTE', (m.cga ? `Архив хранения документа: ${m.cga}\n` : '') + `Страница в Яндекс Архиве: ${u.clean}`);
      }
      added.push({ lines: rec });
      who.forEach((x) => {
        const r = indi.get(x);
        if (variant === 'source') { r.lines.push(`1 SOUR ${id}`); emit(r.lines, 2, 'PAGE', where); }
        else r.lines.push(`1 OBJE ${id}`);
        stats.links++; stats.persons.add(x);
      });
      stats.pages++;
    }
    // кодировка выходного файла — UTF-8: в шапке указываем это
    const head = recs.find((r) => r.tag === 'HEAD');
    if (head && !o.keepChar) {
      const i = head.lines.findIndex((l) => /^\s*1\s+CHAR\b/i.test(l));
      if (i >= 0) head.lines[i] = '1 CHAR UTF-8'; else head.lines.push('1 CHAR UTF-8');
    }
    const trlr = recs.findIndex((r) => r.tag === 'TRLR');
    const at = trlr >= 0 ? trlr : recs.length;
    const all = recs.slice(0, at).concat(added, recs.slice(at));
    if (trlr < 0) all.push({ lines: ['0 TRLR'] });
    stats.persons = stats.persons.size;
    return { text: all.map((r) => r.lines.join(eol)).join(eol) + eol, stats };
  }

  const api = { apply, emit, splitRecords, stripOwn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GedcomWriter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
