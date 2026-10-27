// «Сохранить Скан» — оригиналы сканов Яндекс Архива (по логике Scrpt_YA_Orig_Scan 1.3.0, MIT,
// https://github.com/MasterGoodwin2/Scrpt_YA_Orig_Scan; тот основан на Archive Original Downloader).
//
// Выполняется ВНУТРИ вкладки ya.ru / yandex.ru (где пользователь вошёл в Яндекс): через Claude in Chrome
// (javascript_tool), консоль браузера или как часть расширения. Ничего не распознаёт, только сохраняет файлы.
//
//   YaOrigScan.save()                                  — скан текущей страницы, один JPG
//   YaOrigScan.save({ pages: [865, 866, 867] })        — несколько страниц того же дела, один ZIP
//   YaOrigScan.save({ from: 865, to: 880 })            — диапазон, один ZIP (+ info.txt, errors.txt)
//   YaOrigScan.save({ fileId: '<id дела>', from, to }) — другое дело
//   опции: quality (0.4 = 40%, 1 = без пересжатия), delay (пауза между страницами, мс; по умолчанию 1200),
//          download (false — не сохранять, только вернуть результат)
//
// Результат (Promise) сохраняется и в window.__yaOrigScan: {ok, file, pages:[{page, name, w, h, origSize, size, err}], cga}
// — удобно читать по частям, если вызов идёт через инструмент, который не ждёт Promise.
(function (root) {
  'use strict';

  const LEAF_RE = /^\/archive\/catalog\/([^/?#]+)\/(\d+)\/?$/i;
  const MIN_BYTES = 20000;

  const sanitize = (v) => String(v || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function parseNextData(html) {
    const m = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  // данные страницы: id узла скана и путь «ЦГА Москвы / Фонд / Опись / Дело» (breadcrumbs)
  async function pageInfo(fileId, page) {
    const url = `${location.origin}/archive/catalog/${fileId}/${page}`;
    let data = null;
    const cur = location.pathname.match(LEAF_RE);
    if (cur && cur[1] === fileId && +cur[2] === page) {
      const el = document.getElementById('__NEXT_DATA__');
      try { data = el ? JSON.parse(el.textContent) : null; } catch (e) { data = null; }
      const dn = data && data.props && data.props.pageProps ? +data.props.pageProps.docNumber : NaN;
      if (!Number.isNaN(dn) && dn !== page) data = null;            // SPA-переход: тег от другой страницы
    }
    if (!data) {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error('страница: HTTP ' + r.status);
      data = parseNextData(await r.text());
    }
    const pp = data && data.props ? data.props.pageProps : null;
    const node = pp && pp.currentNode;
    if (!node || !node.id) throw new Error('не найден идентификатор скана на странице');
    return { url, nodeId: node.id, crumbs: pp.breadcrumbs || [] };
  }

  // путь из шапки страницы и имя файла: <Архив>_[ЯА]_<фонд>-<опись>-<дело>-<лист 4 цифры>.jpg
  function names(info, page) {
    const find = (t) => info.crumbs.find((c) => c.type === t) || null;
    const archive = find('Archive'), fund = find('Fund'), inv = find('Inventory'), file = find('File');
    const opis = inv && String(inv.code || '').match(/\d+[а-яА-Яa-zA-Z]?/);
    const codes = [fund && fund.code ? String(fund.code).trim() : '', opis ? opis[0] : '', file && file.code ? String(file.code).trim() : ''].filter(Boolean);
    const padded = String(page).padStart(4, '0');
    const prefix = archive && archive.name ? sanitize(archive.name) + '_[ЯА]_' : '';
    const stem = codes.length >= 2 ? prefix + sanitize(codes.join('-')) : 'YA_archive_' + sanitize(info.nodeId);
    const cga = ['Главная', 'Каталог', archive && archive.name, fund && 'Фонд ' + fund.code, opis && 'Опись ' + opis[0],
      file && 'Дело ' + file.code, 'Скан ' + page].filter(Boolean).join('/');
    return { jpg: `${stem}-${padded}.jpg`, stem, cga };
  }

  async function fetchOriginal(nodeId) {
    const g = await fetch('/archive/api/image-grant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ nodeId, type: 'original' }),
    });
    if (!g.ok) throw new Error('image-grant: HTTP ' + g.status + (g.status === 401 || g.status === 403 ? ' (войдите в Яндекс)' : ''));
    const grant = await g.json();
    if (!grant || !grant.url || !grant.token) throw new Error('image-grant: некорректный ответ');
    const r = await fetch(new URL(grant.url, location.origin).href, { headers: { 'X-Archive-Image-Token': grant.token }, credentials: 'include' });
    if (!r.ok) throw new Error('оригинал: HTTP ' + r.status);
    const ct = String(r.headers.get('content-type') || '').toLowerCase();
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (ct && ct.indexOf('image/') !== 0) throw new Error('сервер вернул не изображение (' + ct + ')');
    if (bytes.length < MIN_BYTES) throw new Error('слишком маленький файл (' + bytes.length + ' байт), вероятно превью');
    return bytes;
  }

  // пересжатие в JPG (размеры в пикселях сохраняются); если не меньше оригинала или не удалось — оригинал
  async function recompress(bytes, quality) {
    if (!quality || quality >= 1) return { bytes, w: 0, h: 0, recompressed: false };
    try {
      const bmp = await createImageBitmap(new Blob([bytes]));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0);
      const w = bmp.width, h = bmp.height;
      if (bmp.close) bmp.close();
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
      if (blob && blob.size > 1000 && blob.size < bytes.length) return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h, recompressed: true };
      return { bytes, w, h, recompressed: false };
    } catch (e) {
      return { bytes, w: 0, h: 0, recompressed: false };
    }
  }

  // ZIP без сжатия (JPG уже сжат): несколько сканов — одной загрузкой, без запроса «скачать несколько файлов»
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let off = 0;
    for (const f of files) {
      const nm = enc.encode(f.name), crc = crc32(f.data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true); lh.setUint16(26, nm.length, true);
      parts.push(new Uint8Array(lh.buffer), nm, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, f.data.length, true); ch.setUint32(24, f.data.length, true);
      ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), nm);
      off += 30 + nm.length + f.data.length;
    }
    const cs = central.reduce((a, c) => a + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cs, true); end.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  async function save(opts) {
    opts = opts || {};
    const cur = location.pathname.match(LEAF_RE);
    const fileId = opts.fileId || (cur && cur[1]);
    if (!fileId) throw new Error('откройте страницу скана /archive/catalog/<id>/<номер> или передайте fileId');
    let pages = opts.pages;
    if (!pages) {
      const from = opts.from || (cur && +cur[2]), to = opts.to || from;
      pages = []; for (let n = from; n <= to; n++) pages.push(n);
    }
    const quality = opts.quality === undefined ? 0.4 : opts.quality;
    const delay = opts.delay === undefined ? 1200 : opts.delay;
    const out = { ok: false, pages: [], file: '', cga: '' };
    root.__yaOrigScan = out;
    const files = [], info = [];
    let stem = '';
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const rec = { page };
      try {
        const pi = await pageInfo(fileId, page);
        const nm = names(pi, page);
        stem = stem || nm.stem; rec.name = nm.jpg; rec.cga = nm.cga; rec.url = pi.url;
        const orig = await fetchOriginal(pi.nodeId);
        const rc = await recompress(orig, quality);
        Object.assign(rec, { w: rc.w, h: rc.h, origSize: orig.length, size: rc.bytes.length, recompressed: rc.recompressed });
        files.push({ name: nm.jpg, data: rc.bytes });
        info.push(`${nm.jpg}\t${nm.cga}\t${pi.url}`);
      } catch (e) {
        rec.err = e && e.message ? e.message : String(e);
      }
      out.pages.push(rec);
      if (i + 1 < pages.length && delay) await sleep(delay);
    }
    if (!files.length) return out;
    out.cga = out.pages.find((p) => p.cga) ? out.pages.find((p) => p.cga).cga : '';
    if (files.length === 1 && pages.length === 1) {
      out.file = files[0].name;
      if (opts.download !== false) download(new Blob([files[0].data], { type: 'image/jpeg' }), out.file);
    } else {
      const errs = out.pages.filter((p) => p.err).map((p) => `${p.page}\t${p.err}`);
      const enc = new TextEncoder();
      const extra = [{ name: 'info.txt', data: enc.encode('файл\tпуть в архиве\tссылка\n' + info.join('\n') + '\n') }];
      if (errs.length) extra.push({ name: 'errors.txt', data: enc.encode(errs.join('\n') + '\n') });
      out.file = `${stem}-${String(pages[0]).padStart(4, '0')}-${String(pages[pages.length - 1]).padStart(4, '0')}.zip`;
      const z = zip(files.concat(extra));
      out.zipSize = z.size;
      if (opts.download !== false) download(z, out.file);
    }
    out.ok = true;
    return out;
  }

  const api = { save, pageInfo, names, fetchOriginal, recompress, zip };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YaOrigScan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
