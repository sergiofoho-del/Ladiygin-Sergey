#!/usr/bin/env node
// Пересборка result.xlsx из отладочного пакета запуска (исповедные ведомости) — без повторной загрузки страниц.
// Берёт run_summary.json и <год>_<док>_p<стр>_next_data.json из папки yaarchive_debug/<дата_время>/ и прогоняет
// их через текущие confession-rows.js / layout.js — тот же путь, что в расширении. Так новая версия алгоритма
// применяется к уже собранным страницам.
//
// Запуск: node tools/rebuild_from_debug.js <папка yaarchive_debug/дата_время> [result.xlsx]
const fs = require('fs'), path = require('path');
const X = path.join(__dirname, '..');
global.Logic = require(path.join(X, 'logic.js'));
global.ConfessionRows = require(path.join(X, 'confession-rows.js'));
global.RevisionRows = require(path.join(X, 'revision-rows.js'));
const Layout = require(path.join(X, 'layout.js'));
const XlsxWriter = require(path.join(X, 'xlsx-writer.js'));
const version = JSON.parse(fs.readFileSync(path.join(X, 'manifest.json'), 'utf8')).version;

const dir = process.argv[2];
if (!dir) { console.error('Укажите папку отладочного пакета (yaarchive_debug/<дата_время>).'); process.exit(2); }
const outFile = process.argv[3] || path.join(dir, `result_${version.replace(/\./g, '_')}.xlsx`);
const summary = JSON.parse(fs.readFileSync(path.join(dir, 'run_summary.json'), 'utf8'));
if (summary.mode !== 'confession') { console.error('Пересборка поддерживает только режим «Исповедные ведомости».'); process.exit(2); }

// страницы по файлам _next_data.json: ключ «год|первые 8 символов fileId|страница»
const nodes = new Map();
for (const f of fs.readdirSync(dir)) {
  const m = f.match(/^(\d{4}|год)_([0-9a-f]{8})_p(\d+)_next_data\.json$/);
  if (m) nodes.set(`${m[1]}|${m[2]}|${m[3]}`, f);
}

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
function ageValue(age) {
  const m = String(age || '').match(/^\s*(\d{1,3})?\s*(?:(\d)\s*\/\s*(\d))?/);
  if (!m || !(m[1] || m[2])) return null;
  return parseInt(m[1] || '0', 10) + (m[2] ? parseInt(m[2], 10) / parseInt(m[3], 10) : 0);
}
function birthYear(year, age) {
  const v = ageValue(age), y = parseInt(year, 10);
  return v === null || !y ? '' : y - Math.floor(v);
}

// ссылки запуска — в том порядке, в каком они обрабатывались; страницы ссылки — из run_summary.pages
const rowRecords = [], blockRecords = [], sheetRows = [], linkRows = [];
let families = 0;
for (const link of summary.links) {
  const [year, url, rng] = link;
  const [lo, hi] = String(rng).split(/[–-]/).map((v) => parseInt(v, 10));
  const seen = new Set();
  const pages = summary.pages
    .filter((p) => p.year === year && url.includes(p.fileId) && p.page >= lo && p.page <= (hi || lo))
    .filter((p) => (seen.has(p.page) ? false : seen.add(p.page)))
    .sort((a, b) => a.page - b.page);
  const st = Layout.newState(), fams = [], hows = new Set(), foundAll = new Set();
  for (const pg of pages) {
    const f = nodes.get(`${year || 'год'}|${String(pg.fileId).slice(0, 8)}|${pg.page}`);
    if (!f) { sheetRows.push({ year, page: pg.page, found: '', url: pg.url, text: 'нет файла данных страницы в пакете', check: '' }); continue; }
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const node = d.props.pageProps.currentNode;
    const text = node.textBlocks.map((t) => String(t.text || '').trim()).filter(Boolean).join('\n');
    const found = new Set(Logic.findSettlements(text, 'confession'));
    st.lastRep = null;
    const how = Layout.processConfessionNode(node, { url: pg.url, page: pg.page, year }, st, 'confession', fams);
    if (st.lastRep) for (const mk of st.lastRep.settlement_marks) if (!String(mk.name).startsWith('other:')) found.add(mk.name);
    found.forEach((x) => foundAll.add(x));
    sheetRows.push({ year, page: pg.page, found: [...found].sort().join('; '), url: pg.url, text, check: st.checks[pg.page] || '' });
    if (how) hows.add(how);
  }
  Layout.finish(st, fams);
  families += fams.length;
  st.rows.forEach((r) => rowRecords.push(Object.assign({ year }, r)));
  (st.blocks || []).forEach((b) => blockRecords.push(Object.assign({ year }, b)));
  const persons = fams.reduce((acc, f) => acc + f.persons.reduce((a, p) => a + (p.rows && p.rows.length ? p.rows.length : 1), 0), 0);
  linkRows.push([year, url, rng, pages.length, foundAll.size, [...foundAll].sort().join('; '), link[6], fams.length, persons,
    `пересобрано версией ${version} из отладочного пакета`,
    [st.skipped.length ? `страницы без таблицы: ${st.skipped.join(', ')}` : ''].filter(Boolean).join('; ')]);
}

// листы — как buildConfessionSheets() в app.js
const head = ['Год', 'Населённый пункт', 'Двор №', 'Человек (как распознано)', 'Пол', 'Номер', 'Возраст', 'Год рождения', 'Примечание', 'Ссылка на страницу'];
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
const merges = [];
const runs = (col, key) => {
  let s = 1;
  for (let r = 2; r <= people.length; r++) {
    if (r === people.length || key(r) !== key(s)) { if (r - 1 > s) merges.push([s, col, r - 1, col]); s = r; }
  }
};
const S = XlsxWriter.STYLE;
runs(1, (r) => `${people[r][0]}|${people[r][1]}`);
runs(2, (r) => (people[r][2] === '' || people[r][2] == null) ? `empty${r}` : `${people[r][0]}|${people[r][1]}|${people[r][2]}|${yards[r - 1].calc}`);
const styleAt = (r, c) => (c === 1 ? S.SETTLEMENT : c === 2 ? (yards[r - 1] && yards[r - 1].calc ? S.YARD_CALC : S.YARD) : c === 3 ? S.PERSON : undefined);
const pw = widthsFor(people); pw[1] = 9; pw[2] = 7; pw[3] = 45; pw[8] = 40;
const blocks = [['Год', 'Населённый пункт', 'Двор №', 'Текст блока целиком (как распознан)', 'Людей в блоке', 'Ссылка на страницу']];
blockRecords.forEach((b) => blocks.push([b.year, b.settlement, b.yard, b.text, b.persons, b.url].map(trunc)));
const bw = widthsFor(blocks); bw[3] = 70;
const pageRows = [['Год', 'Найденные НП округи', 'Ссылка', 'Распознанный текст страницы', 'Проверка страницы (найдено ячеек по столбцам)']];
sheetRows.forEach((r) => pageRows.push([r.year, r.found, r.url, r.text, r.check || ''].map(trunc)));
const linkOut = [['Год', 'Исходная ссылка', 'Диапазон из ссылки', 'Просмотрено страниц', 'Найдено НП (шт.)', 'Какие НП', 'Решение',
  'Дворов (семей)', 'Людей', 'Как собрано', 'Примечание']];
linkRows.forEach((r) => linkOut.push(r.map(trunc)));

XlsxWriter.build([
  { name: 'Люди', rows: people, widths: pw, styleAt, merges },
  { name: 'Блоки текста', rows: blocks, widths: bw },
  { name: 'Страницы', rows: pageRows, widths: widthsFor(pageRows) },
  { name: 'Ссылки', rows: linkOut, widths: widthsFor(linkOut) },
]).then((bytes) => {
  fs.writeFileSync(outFile, Buffer.from(bytes));
  console.log(`Готово: ${outFile} — ссылок ${linkRows.length}, страниц ${sheetRows.length}, дворов ${families}, строк людей ${rowRecords.length}`);
});
