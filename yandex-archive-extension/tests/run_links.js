// node tests/run_links.js — проверка разбора ссылок (HTML, GEDCOM), очистки «?center=» и удаления дубликатов
const assert = require('assert');
const L = require('../links-tools.js');
const A = '3aa266f8-a0ed-434d-bd5d-c095d45efc1b', B = 'bfed2966-e671-4c18-bbb0-a9551ad28f8e';

// 1. одна страница, ?center=, yandex.ru и ya.ru — одна и та же страница
let p = L.parseArchiveUrl(`https://ya.ru/archive/catalog/${A}/866?center=0.52,0.31&zoom=3`);
assert.deepStrictEqual([p.status, p.fileId, p.pages], ['ok', A, [866]]);
p = L.parseArchiveUrl(`https://yandex.ru/archive/catalog/${A}/866/`);
assert.deepStrictEqual(p.pages, [866]);
// 2. диапазон в ссылке поиска
p = L.parseArchiveUrl(`https://ya.ru/archive/search?query=x&fileId=${B}&sheet_page_from=163&sheet_page_to=165`);
assert.deepStrictEqual(p.pages, [163, 164, 165]);
p = L.parseArchiveUrl(`https://ya.ru/archive/search?fileId=${B}&sheet_page_from=7`);
assert.deepStrictEqual(p.pages, [7]);
p = L.parseArchiveUrl(`https://ya.ru/archive/search?fileId=${B}&sheet_page_from=9&sheet_page_to=7`);
assert.deepStrictEqual(p.pages, [7, 8, 9]);
// 3. пропускаемые
assert.strictEqual(L.parseArchiveUrl(`https://ya.ru/archive/catalog/${A}`).status, 'skip');
assert.strictEqual(L.parseArchiveUrl('https://ya.ru/maps').status, 'skip');
assert.strictEqual(L.parseArchiveUrl('https://example.com/archive/catalog/x/1').status, 'skip');

// 4. HTML: href + текст, &amp;, дубликаты
const html = `<p>1850 <a href="https://ya.ru/archive/catalog/${B}/165?center=1,2&amp;zoom=2">стр</a></p>
<p><a href="https://ya.ru/archive/catalog/${B}/165">та же</a></p>
<p><a href="https://yandex.ru/archive/catalog/${B}/166?center=3">другая</a> текст https://ya.ru/archive/catalog/${A}/1.</p>
<p><a href="https://ya.ru/archive/search?fileId=${B}&amp;sheet_page_from=165&amp;sheet_page_to=167">диапазон</a></p>
<p><a href="https://ya.ru/archive/catalog/${A}">дело</a></p>`;
const src = L.htmlLinks(html);
assert.strictEqual(src.length, 6);   // 5 href + 1 в тексте
const plan = L.buildPlan(src);
assert.deepStrictEqual(plan.unique.map((u) => u.key), [`${B}:165`, `${B}:166`, `${A}:1`, `${B}:167`]);
assert.strictEqual(plan.unique[0].origs.length, 3);   // две ссылки на страницу + диапазон, в который она входит
assert.ok(plan.unique[0].origs[0].includes('center=1,2&zoom=2'), 'исходная ссылка сохраняется как есть, &amp; раскодирован');
assert.deepStrictEqual(plan.entries.map((e) => e.status.split(';')[0]),
  ['страница', 'дубликат (страница уже в списке)', 'страница', 'страница', 'диапазон: 3 стр.', 'пропущена: в ссылке нет номера страницы (это дело/опись целиком)']);
assert.ok(!L.fixedHtml(plan).includes('center'));
assert.strictEqual((L.fixedHtml(plan).match(/<a /g) || []).length, 4);

// 5. GEDCOM: CONC разрывает ссылку, CONT, @-записи, кириллица в имени, чужие домены игнорируются
const ged = [
  '0 HEAD', '1 CHAR UTF-8',
  '0 @I1@ INDI', '1 NAME Иван /Ладыгин/', '1 NOTE Ревизская сказка https://ya.ru/archive/catalog/' + B + '/16',
  '2 CONC 5?center=0.1,0.2 и ещё', '2 CONT см. https://example.com/x и https://www.yandex.ru/archive/catalog/' + A + '/9).',
  '0 @S1@ SOUR', '1 WWW https://ya.ru/archive/catalog/' + B + '/165', '0 TRLR'].join('\r\n');
const gl = L.gedcomLinks(ged);
assert.deepStrictEqual(gl.map((x) => x.url), [`https://ya.ru/archive/catalog/${B}/165?center=0.1,0.2`, `https://www.yandex.ru/archive/catalog/${A}/9`, `https://ya.ru/archive/catalog/${B}/165`]);
assert.ok(gl[0].where.includes('@I1@') && gl[0].where.includes('Иван Ладыгин') && gl[0].where.includes('NOTE'), gl[0].where);
const gp = L.buildPlan(gl);
assert.strictEqual(gp.unique.length, 2);
assert.strictEqual(gp.unique[0].origs.length, 2);

// 6. кодировки
const enc = (s, e) => e === 'u16' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]) : Buffer.from(s, 'utf8');
assert.strictEqual(L.decodeBytes(enc('0 HEAD\nИван', 'u16')), '0 HEAD\nИван');
assert.strictEqual(L.decodeBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), enc('Иван')])), 'Иван');
assert.strictEqual(L.decodeBytes(new TextEncoder().encode('0 HEAD')), '0 HEAD');
assert.strictEqual(L.decodeBytes(Buffer.from([0xc8, 0xe2, 0xe0, 0xed])), 'Иван');   // windows-1251

// 7. листы Excel
const meta = { [plan.unique[0].clean]: { cga: 'ЦГА Москвы/Фонд 51/Опись 8/Дело 588/Скан 165', scanName: 'a.jpg', scanFile: 'Archive_Scans/a.jpg', scanHref: 'Archive_Scans/a.jpg' },
  [plan.unique[1].clean]: { err: 'нет данных' } };
const sh = L.sheets(plan, meta);
assert.deepStrictEqual(sh[0].rows[0], ['Ссылка на страницу', 'Локальная Ссылка на страницу', 'Ссылка на ЦГА Москвы']);
assert.deepStrictEqual(sh[0].rows[1].slice(1), ['a.jpg', 'ЦГА Москвы/Фонд 51/Опись 8/Дело 588/Скан 165']);
assert.strictEqual(sh[0].rows[2][1], 'не скачан: нет данных');
assert.strictEqual(sh[0].rows.length, 5);
assert.deepStrictEqual(sh[0].links.map((l) => [l[0], l[1]]), [[1, 0], [1, 1], [2, 0], [3, 0], [4, 0]]);
assert.strictEqual(sh[1].rows.length, 1 + 6);
console.log('links: OK');
