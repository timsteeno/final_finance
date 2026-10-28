// Functional end-to-end suite for Open BG Remover.
// Usage: node tests/e2e.mjs [baseUrl]   (default http://localhost:8765/)
// Env: SHOTS=<dir> to save screenshots, HEADED=1 to watch, ONLY_FAST=1 to skip the 1024 models.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const { chromium } = createRequire(import.meta.url)('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const base = process.argv[2] || 'http://localhost:8765/';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'obr-e2e');
fs.mkdirSync(SHOTS, { recursive: true });
const INFER_TIMEOUT = 300_000;

// ---------------------------------------------------------------- reporting
const results = [];
const logs = [];
let currentCheck = '(setup)';
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function approx(a, b, tol, msg) { assert(Math.abs(a - b) <= tol, `${msg || ''} expected ~${b} (±${tol}), got ${a}`); }
async function check(name, fn) {
  currentCheck = name;
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${note ? '  — ' + note : ''}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
    try { await page.screenshot({ path: path.join(SHOTS, 'fail-' + name.replace(/[^a-z0-9]+/gi, '_').slice(0, 60) + '.png') }); } catch { /* ignore */ }
  }
}
const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png') }).catch(() => {});

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ headless: !process.env.HEADED });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
await context.addInitScript(() => {
  // In-page test helpers.
  const b64ToBytes = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const bytesToB64 = async (blob) => { const u = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  window.__t = {
    b64ToBytes, bytesToB64,
    // Decode an image and sample it. pts: [[fx, fy]] fractions of width/height.
    async analyze(b64, mime, pts = []) {
      const bmp = await createImageBitmap(new Blob([b64ToBytes(b64)], { type: mime }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const { width: w, height: h } = bmp;
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, w, h).data;
      const px = (x, y) => { x = Math.min(w - 1, Math.max(0, Math.round(x))); y = Math.min(h - 1, Math.max(0, Math.round(y))); const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
      let aSum = 0, rgbSum = 0, transparent = 0, opaque = 0;
      for (let i = 0; i < d.length; i += 4) { aSum += d[i + 3]; rgbSum += d[i] + d[i + 1] + d[i + 2]; if (d[i + 3] < 10) transparent++; if (d[i + 3] > 245) opaque++; }
      const n = w * h;
      return { w, h, pts: pts.map(([fx, fy]) => px(fx * (w - 1), fy * (h - 1))), alphaMean: aSum / n, rgbMean: rgbSum / n / 3, transparentFrac: transparent / n, opaqueFrac: opaque / n };
    },
    async makeImage(kind) {
      let c, mime = 'image/png', q;
      if (kind === 'transparent') {
        // 1200x900, transparent left half, opaque coloured shapes on the right.
        c = new OffscreenCanvas(1200, 900);
        const x = c.getContext('2d');
        x.fillStyle = '#e8d8b0'; x.fillRect(600, 0, 600, 900);
        x.fillStyle = '#d02030'; x.beginPath(); x.arc(900, 450, 200, 0, Math.PI * 2); x.fill();
        x.fillStyle = 'rgba(0,80,255,0.5)'; x.fillRect(100, 100, 300, 300); // semi-transparent square in the transparent half
      } else if (kind === 'large') {
        c = new OffscreenCanvas(5000, 4000);
        const x = c.getContext('2d');
        const g = x.createLinearGradient(0, 0, 5000, 4000); g.addColorStop(0, '#9ec9e8'); g.addColorStop(1, '#f2efe6');
        x.fillStyle = g; x.fillRect(0, 0, 5000, 4000);
        x.fillStyle = '#2b2d42'; x.beginPath(); x.ellipse(2500, 2200, 1100, 1500, 0, 0, Math.PI * 2); x.fill();
        x.fillStyle = '#e07a5f'; x.beginPath(); x.arc(2500, 1000, 600, 0, Math.PI * 2); x.fill();
        mime = 'image/jpeg'; q = 0.85;
      } else if (kind === 'bgphoto') {
        c = new OffscreenCanvas(300, 200);
        const x = c.getContext('2d'); x.fillStyle = '#0000ff'; x.fillRect(0, 0, 300, 200);
      } else if (kind === 'small') {
        c = new OffscreenCanvas(320, 240);
        const x = c.getContext('2d'); x.fillStyle = '#88aa66'; x.fillRect(0, 0, 320, 240);
        x.fillStyle = '#663311'; x.fillRect(100, 60, 120, 140);
      }
      const blob = await c.convertToBlob({ type: mime, quality: q });
      return { b64: await bytesToB64(blob), mime };
    },
    toClient(ix, iy) {
      const v = window.__obr.viewer; const b = v.canvas.getBoundingClientRect(); const { s, ox, oy } = v._transform();
      return { x: b.left + (ix * s + ox) / v._dpr, y: b.top + (iy * s + oy) / v._dpr };
    },
    alphaIn(x0, y0, w, h) {
      const it = window.__obr.state.active; const d = it.cutout.data; let s = 0;
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) s += d[(y * it.width + x) * 4 + 3];
      return s;
    },
    cutoutHash() { const d = window.__obr.state.active.cutout.data; let h = 0; for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]) >>> 0; return h; },
  };
});
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] (${currentCheck}) ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] (${currentCheck}) ${e.message}`));
page.on('worker', (w) => w.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[worker ${m.type()}] (${currentCheck}) ${m.text()}`); }));
page.on('requestfailed', (r) => logs.push(`[requestfailed] (${currentCheck}) ${r.url()} ${r.failure()?.errorText}`));

// ---------------------------------------------------------------- helpers
const S = (fn, arg) => page.evaluate(fn, arg);
const items = () => S(() => window.__obr.state.items.map((i) => ({ id: i.id, name: i.name, status: i.status, error: i.error, w: i.width, h: i.height, model: i.modelUsed, backend: i.backend, downscaled: i.downscaled })));
const activeInfo = () => S(() => { const i = window.__obr.state.active; return i && { id: i.id, name: i.name, status: i.status, error: i.error, w: i.width, h: i.height, model: i.modelUsed, backend: i.backend, timings: i.timings, undo: i.undoStack.length, redo: i.redoStack.length }; });
async function waitAllSettled(timeout = INFER_TIMEOUT) {
  await page.waitForFunction(() => { const s = window.__obr.state; return s.items.length && s.items.every((i) => i.status === 'done' || i.status === 'error'); }, null, { timeout, polling: 250 });
}
async function waitItem(name, timeout = INFER_TIMEOUT) {
  await page.waitForFunction((n) => { const i = window.__obr.state.items.find((x) => x.name === n || x.name.startsWith(n)); return i && (i.status === 'done' || i.status === 'error'); }, name, { timeout, polling: 250 });
  return S((n) => { const i = window.__obr.state.items.find((x) => x.name === n || x.name.startsWith(n)); return { name: i.name, status: i.status, error: i.error, w: i.width, h: i.height, model: i.modelUsed, backend: i.backend, timings: i.timings, downscaled: i.downscaled }; }, name);
}
async function waitActiveDone(timeout = INFER_TIMEOUT) {
  await page.waitForFunction(() => { const i = window.__obr.state.active; return i && (i.status === 'done' || i.status === 'error'); }, null, { timeout, polling: 250 });
  const a = await activeInfo();
  assert(a.status === 'done', `active item status ${a.status}: ${a.error}`);
  return a;
}
async function download(trigger, timeout = 60_000) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout }), trigger()]);
  const p = await dl.path();
  return { name: dl.suggestedFilename(), buf: fs.readFileSync(p) };
}
async function exportActive(pts = []) {
  const { name, buf } = await download(() => page.click('#download-btn'));
  const sig = buf.subarray(0, 12);
  const mime = sig[0] === 0x89 ? 'image/png' : sig[0] === 0xff ? 'image/jpeg' : sig.toString('latin1', 8, 12) === 'WEBP' ? 'image/webp' : 'application/octet-stream';
  const a = await S(([b64, m, p]) => window.__t.analyze(b64, m, p), [buf.toString('base64'), mime, pts]);
  return { name, buf, mime, ...a };
}
const CORNERS = [[0.02, 0.02], [0.98, 0.02], [0.5, 0.5]];
async function setRange(sel, v) {
  await S(([s, val]) => { const el = document.querySelector(s); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, [sel, String(v)]);
}
async function openSect(id) { await S((i) => { document.getElementById(i).open = true; }, id); }
async function blurFocus() { await S(() => document.activeElement && document.activeElement.blur && document.activeElement.blur()); }
async function toast() { return S(() => { const t = document.getElementById('toast'); return { hidden: t.hidden, text: t.textContent, error: t.classList.contains('error') }; }); }
async function hideToast() { await S(() => { document.getElementById('toast').hidden = true; }); }
async function waitToast(re, timeout = 10_000) {
  await page.waitForFunction((src) => { const t = document.getElementById('toast'); return !t.hidden && new RegExp(src, 'i').test(t.textContent); }, re.source, { timeout });
  return toast();
}
async function selectByName(name) {
  await S((n) => { const i = window.__obr.state.items.findIndex((x) => x.name === n); document.querySelectorAll('#queue-list .qitem .qsel')[i].click(); }, name);
}
async function drag(from, to, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}
async function makeFixture(kind) {
  const { b64, mime } = await S((k) => window.__t.makeImage(k), kind);
  return { buffer: Buffer.from(b64, 'base64'), mimeType: mime };
}
function pngDims(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function parseZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  assert(eocd >= 0, 'no EOCD record');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  assert(cdOff + cdSize === eocd, `central directory bounds mismatch (${cdOff}+${cdSize} != ${eocd})`);
  const entries = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    assert(buf.readUInt32LE(p) === 0x02014b50, `bad central header sig at ${p}`);
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), loff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + el + cl;
    assert(buf.readUInt32LE(loff) === 0x04034b50, `bad local header sig for ${name}`);
    const lnl = buf.readUInt16LE(loff + 26), lel = buf.readUInt16LE(loff + 28);
    const data = buf.subarray(loff + 30 + lnl + lel, loff + 30 + lnl + lel + csize);
    entries.push({ name, method, crc, csize, usize, data, crcOk: crc32(data) === crc });
  }
  return entries;
}

// ================================================================ TESTS
await check('page loads, cross-origin isolated, debug hook present', async () => {
  await page.goto(base);
  // coi-serviceworker reloads the page once on first visit.
  const t0 = Date.now();
  for (;;) {
    try {
      const ok = await page.evaluate(() => self.crossOriginIsolated && !!window.__obr && !!window.__t);
      if (ok) break;
    } catch { /* navigating */ }
    if (Date.now() - t0 > 20000) throw new Error('page never became crossOriginIsolated with __obr');
    await page.waitForTimeout(300);
  }
  await page.waitForLoadState('networkidle');
  assert(await page.title() === 'Open BG Remover', 'title');
  assert(await page.isVisible('#landing'), 'landing visible');
  assert(await page.isHidden('#workspace'), 'workspace hidden');
});

await check('model select lists fast/balanced/best, default balanced', async () => {
  const opts = await page.$$eval('#model-select option', (o) => o.map((x) => x.value));
  assert(JSON.stringify(opts) === '["fast","balanced","best"]', 'options ' + opts);
  assert(await page.inputValue('#model-select') === 'balanced', 'default');
  await page.selectOption('#model-select', 'fast');
  assert(await S(() => window.__obr.state.model) === 'fast', 'state.model fast');
});

await check('about dialog opens and closes', async () => {
  await page.click('#about-btn');
  assert(await S(() => document.getElementById('about-dialog').open), 'dialog open');
  await page.click('#about-dialog .dialog-actions button');
  assert(!(await S(() => document.getElementById('about-dialog').open)), 'dialog closed');
});

await check('upload button / dropzone open a file chooser', async () => {
  const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.click('#upload-btn')]);
  assert(fc.isMultiple(), 'file input should be multiple');
  const [fc2] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.click('#dropzone .hint')]);
  assert(fc2, 'dropzone click opens chooser');
  assert(await page.isVisible('#landing'), 'still on landing');
});

await check('URL load: 404 URL shows error toast', async () => {
  await page.fill('#url-input', base + 'samples/does-not-exist.jpg');
  await page.click('#url-form button');
  const t = await waitToast(/HTTP 404/);
  assert(t.error, 'toast should be error-styled');
  assert(await page.isVisible('#landing'), 'still on landing');
  await hideToast();
});

await check('URL load: unreachable host shows error toast', async () => {
  await page.fill('#url-input', 'http://localhost:1/nope.png');
  await page.click('#url-form button');
  await waitToast(/couldn't download/);
  assert(await page.textContent('#url-form button') === 'Load', 'Load button label restored');
  await hideToast();
});

await check('URL load: non-image URL shows "not an image" toast', async () => {
  await page.fill('#url-input', base + 'README.md');
  await page.click('#url-form button');
  await waitToast(/isn't an image/);
  assert(await page.isVisible('#landing'), 'still on landing');
  await hideToast();
});

await check('sample button (astronaut) processes with Fast model', async () => {
  await page.click('.sample[data-src="samples/astronaut.jpg"]');
  await page.waitForSelector('#workspace:not([hidden])', { timeout: 10000 });
  const a = await waitActiveDone();
  assert(a.name === 'astronaut.jpg', 'name ' + a.name);
  assert(a.w === 512 && a.h === 512, `dims ${a.w}x${a.h}`);
  assert(a.model === 'fast', 'modelUsed ' + a.model);
  assert(/^wasm|webgpu/.test(a.backend), 'backend ' + a.backend);
  const info = await page.textContent('#stage-info');
  assert(/Fast/.test(info) && /512×512/.test(info), 'stage-info: ' + info);
  assert(await page.isHidden('#stage-overlay'), 'overlay hidden after done');
  await shot('01-astronaut-fast');
  return `${a.backend}, ${a.timings.total}ms`;
});

let baseline; // PNG export of astronaut, transparent bg
await check('PNG export: name, signature, dims, transparent corners, opaque centre', async () => {
  baseline = await exportActive(CORNERS);
  assert(baseline.name === 'astronaut-no-bg.png', 'filename ' + baseline.name);
  assert(baseline.buf.subarray(0, 8).equals(PNG_SIG), 'PNG signature');
  assert(baseline.w === 512 && baseline.h === 512, `dims ${baseline.w}x${baseline.h}`);
  const [tl, tr, c] = baseline.pts;
  assert(tl[3] < 25 && tr[3] < 25, `top corners alpha ${tl[3]}, ${tr[3]}`);
  assert(c[3] > 230, `centre alpha ${c[3]}`);
  assert(baseline.transparentFrac > 0.05 && baseline.opaqueFrac > 0.2, `transparent ${baseline.transparentFrac.toFixed(3)} opaque ${baseline.opaqueFrac.toFixed(3)}`);
  const note = await page.textContent('#download-note');
  assert(/512 × 512/.test(note), 'download note ' + note);
  return `alpha tl=${tl[3]} tr=${tr[3]} c=${c[3]}, transp=${(baseline.transparentFrac * 100).toFixed(0)}%`;
});

await check('JPG export: JPEG signature, dims, white where transparent, quality row', async () => {
  await page.selectOption('#fmt-select', 'jpg');
  assert(await page.isVisible('#quality-row'), 'quality row visible for jpg');
  assert(/white background/.test(await page.textContent('#download-note')), 'note mentions white background');
  await setRange('#quality-range', 60);
  assert((await page.textContent('#quality-out')) === '60', 'quality output');
  const r = await exportActive(CORNERS);
  assert(r.name === 'astronaut-no-bg.jpg', r.name);
  assert(r.buf[0] === 0xff && r.buf[1] === 0xd8, 'JPEG signature');
  assert(r.w === 512 && r.h === 512, `dims ${r.w}x${r.h}`);
  const [tl] = r.pts;
  assert(tl[0] > 235 && tl[1] > 235 && tl[2] > 235 && tl[3] === 255, 'corner should be white: ' + tl);
  await setRange('#quality-range', 92);
});

await check('WebP export: RIFF/WEBP signature, dims, keeps alpha', async () => {
  await page.selectOption('#fmt-select', 'webp');
  const r = await exportActive(CORNERS);
  assert(r.name === 'astronaut-no-bg.webp', r.name);
  assert(r.buf.toString('latin1', 0, 4) === 'RIFF' && r.buf.toString('latin1', 8, 12) === 'WEBP', 'WebP signature');
  assert(r.w === 512 && r.h === 512, `dims ${r.w}x${r.h}`);
  assert(r.pts[0][3] < 40 && r.pts[2][3] > 220, 'webp alpha corners/centre ' + r.pts.map((p) => p[3]));
  await page.selectOption('#fmt-select', 'png');
  assert(await page.isHidden('#quality-row'), 'quality row hidden for png');
});

await check('size option never upscales small image (625 on 512px)', async () => {
  await page.selectOption('#size-select', '625');
  const r = await exportActive();
  assert(r.w === 512 && r.h === 512, `dims ${r.w}x${r.h}`);
  await page.selectOption('#size-select', 'full');
});

await check('background: colour swatch fills transparent area', async () => {
  await page.click('.bg-types [data-bg="color"]');
  assert(await page.isVisible('#bg-color-sub'), 'colour sub-panel visible');
  assert((await page.$$('.swatch')).length === 24, 'swatch count');
  await page.click('.swatch[data-color="#ff5a5f"]');
  assert(await page.getAttribute('.bg-types [data-bg="color"]', 'aria-checked') === 'true', 'aria-checked');
  assert(await S(() => document.querySelector('.swatch[data-color="#ff5a5f"]').classList.contains('on')), 'swatch marked on');
  const r = await exportActive(CORNERS);
  const [tl] = r.pts;
  assert(tl[0] === 255 && Math.abs(tl[1] - 90) < 3 && Math.abs(tl[2] - 95) < 3 && tl[3] === 255, 'corner ' + tl);
  assert(r.transparentFrac === 0, 'no transparent px');
});

await check('background: gradient swatch differs between corners', async () => {
  await page.click('.swatch[data-color="#667eea>#764ba2"]');
  const r = await exportActive(CORNERS);
  const tl = r.pts[0], br = r.pts[1]; // top-left vs top-right corner
  assert(tl[3] === 255 && br[3] === 255, 'opaque');
  assert(Math.abs(tl[0] - br[0]) + Math.abs(tl[1] - br[1]) > 20, `corners differ ${tl} vs ${br}`);
});

await check('background: custom colour input', async () => {
  await page.fill('#bg-color', '#00ff00');
  const r = await exportActive(CORNERS);
  const [tl] = r.pts;
  assert(tl[0] < 5 && tl[1] > 250 && tl[2] < 5 && tl[3] === 255, 'corner ' + tl);
});

await check('background: blur original (and slider changes output)', async () => {
  await page.click('.bg-types [data-bg="blur"]');
  assert(await page.isVisible('#bg-blur-sub'), 'blur sub-panel');
  const r1 = await exportActive(CORNERS);
  assert(r1.transparentFrac === 0, 'blur bg opaque everywhere, transparent frac ' + r1.transparentFrac);
  assert(!(r1.pts[0][0] < 5 && r1.pts[0][1] > 250), 'not still green');
  await setRange('#bg-blur', 100);
  const r2 = await exportActive(CORNERS);
  assert(!r1.buf.equals(r2.buf), 'blur amount change should change export');
  assert(r2.transparentFrac === 0, 'blur 100 still opaque at edges: transparent frac ' + r2.transparentFrac);
  await shot('02-blur-bg');
  return `corner rgb ${r1.pts[0].slice(0, 3)} -> ${r2.pts[0].slice(0, 3)}`;
});

await check('background: photo via file chooser', async () => {
  const fx = await makeFixture('bgphoto');
  await S(() => { window.__obr.state.active.settings.bg.image = null; }); // ensure chooser path
  const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.click('.bg-types [data-bg="image"]')]);
  await fc.setFiles({ name: 'blue.png', ...fx });
  await page.waitForFunction(() => !!window.__obr.state.active.settings.bg.image);
  assert(/blue\.png/.test(await page.textContent('#bg-image-name')), 'bg image name');
  const r = await exportActive(CORNERS);
  const [tl] = r.pts;
  assert(tl[0] < 10 && tl[1] < 10 && tl[2] > 245 && tl[3] === 255, 'corner should be blue ' + tl);
  await shot('03-photo-bg');
});

await check('background: back to None is transparent again', async () => {
  await page.click('.bg-types [data-bg="transparent"]');
  const r = await exportActive(CORNERS);
  assert(r.pts[0][3] < 25, 'corner alpha ' + r.pts[0][3]);
  assert(r.buf.equals(baseline.buf), 'identical to baseline export');
});

await check('drop shadow adds alpha outside subject, sliders affect it', async () => {
  await openSect('sect-effects');
  assert(await page.isDisabled('#shadow-op'), 'shadow sliders disabled while shadow off');
  await page.check('#shadow-on');
  assert(await page.isEnabled('#shadow-op'), 'sliders enabled');
  await setRange('#shadow-op', 100);
  await setRange('#shadow-y', 10);
  const r = await exportActive(CORNERS);
  assert(r.alphaMean > baseline.alphaMean + 1, `alpha mean ${r.alphaMean.toFixed(1)} vs ${baseline.alphaMean.toFixed(1)}`);
  await setRange('#shadow-x', -10);
  const r2 = await exportActive(CORNERS);
  assert(!r2.buf.equals(r.buf), 'offset X changes output');
  await page.uncheck('#shadow-on');
  await setRange('#shadow-op', 45); await setRange('#shadow-y', 2); await setRange('#shadow-x', 0);
  const r3 = await exportActive();
  assert(r3.buf.equals(baseline.buf), 'shadow off restores baseline');
  return `alpha mean ${baseline.alphaMean.toFixed(1)} -> ${r.alphaMean.toFixed(1)}`;
});

await check('crop to subject: padding 0 matches subject bbox and is smaller than original', async () => {
  await openSect('sect-crop');
  assert(await page.isDisabled('#crop-pad'), 'pad disabled while crop off');
  await page.check('#crop-on');
  await setRange('#crop-pad', 0);
  assert((await page.textContent('#crop-pad-out')) === '0%', 'pad label');
  const bbox = await S(() => window.__obr.state.active.subjectBBox());
  const r = await exportActive();
  assert(r.w === bbox.w && r.h === bbox.h, `export ${r.w}x${r.h} vs bbox ${bbox.w}x${bbox.h}`);
  assert(r.w * r.h < 512 * 512, `crop ${r.w}x${r.h} not smaller than 512x512`);
  await setRange('#crop-pad', 10);
  const r2 = await exportActive([[0, 0]]);
  const pad = Math.round(Math.max(bbox.w, bbox.h) * 0.1);
  const W = 512, H = 512;
  const ew = bbox.w + (bbox.x <= 1 ? 0 : pad) + (bbox.x + bbox.w >= W - 1 ? 0 : pad);
  const eh = bbox.h + (bbox.y <= 1 ? 0 : pad) + (bbox.y + bbox.h >= H - 1 ? 0 : pad);
  assert(r2.w === ew && r2.h === eh, `padded dims ${r2.w}x${r2.h}, expected ${ew}x${eh} (no margin on cut-off edges)`);
  await page.uncheck('#crop-on');
  await setRange('#crop-pad', 5);
  return `bbox ${bbox.w}x${bbox.h}@${bbox.x},${bbox.y}; pad10 -> ${r2.w}x${r2.h}`;
});

let alphaBefore;
await check('erase brush reduces alpha under the stroke', async () => {
  await openSect('sect-brush');
  await page.click('.tools [data-tool="erase"]');
  assert(await S(() => window.__obr.viewer.tool) === 'erase', 'tool erase');
  await setRange('#brush-size', 40);
  await setRange('#brush-hard', 100);
  alphaBefore = await S(() => window.__t.alphaIn(0, 0, 512, 512));
  const box = await S(() => window.__t.alphaIn(200, 240, 112, 32));
  const a = await S(() => window.__t.toClient(200, 256)), b = await S(() => window.__t.toClient(312, 256));
  await drag(a, b);
  const box2 = await S(() => window.__t.alphaIn(200, 240, 112, 32));
  assert(box2 < box * 0.5, `alpha under stroke ${box} -> ${box2}`);
  const ai = await activeInfo();
  assert(ai.undo === 1 && ai.redo === 0, `undo stack ${ai.undo}/${ai.redo}`);
  assert(await page.isEnabled('#undo-btn'), 'undo button enabled');
  await shot('04-erase');
  return `box alpha ${box} -> ${box2}`;
});

let alphaAfterErase;
await check('restore brush brings back alpha with original colours', async () => {
  await page.click('.tools [data-tool="restore"]');
  alphaAfterErase = await S(() => window.__t.alphaIn(0, 0, 512, 512));
  const before = await S(() => window.__t.alphaIn(10, 10, 80, 20));
  const a = await S(() => window.__t.toClient(20, 20)), b = await S(() => window.__t.toClient(80, 20));
  await drag(a, b);
  const after = await S(() => window.__t.alphaIn(10, 10, 80, 20));
  assert(after > before + 80 * 20 * 50, `alpha in corner ${before} -> ${after}`);
  const rgbMatch = await S(() => { const it = window.__obr.state.active; const o = it.getOrigData().data, d = it.cutout.data; const i = (20 * it.width + 50) * 4; return [d[i] === o[i] && d[i + 1] === o[i + 1] && d[i + 2] === o[i + 2], d[i + 3]]; });
  const changed = await S(() => { const it = window.__obr.state.active, d = it.cutout.data; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; for (let y = 0; y < 120; y++) for (let x = 0; x < 200; x++) if (d[(y * it.width + x) * 4 + 3] > 0) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; });
  assert(rgbMatch[0] && rgbMatch[1] === 255, 'restored pixel (50,20) should be original colour & opaque: ' + rgbMatch + '; restored bbox in TL area ' + changed + '; client pts ' + JSON.stringify([a, b]));
  assert((await activeInfo()).undo === 2, 'two undo steps');
  return `corner alpha ${before} -> ${after}`;
});

await check('undo/redo via buttons and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y', async () => {
  await page.click('#undo-btn');
  approx(await S(() => window.__t.alphaIn(0, 0, 512, 512)), alphaAfterErase, 0, 'after undo(restore)');
  await blurFocus();
  await page.keyboard.press('Control+z');
  approx(await S(() => window.__t.alphaIn(0, 0, 512, 512)), alphaBefore, 0, 'after ctrl+z(erase)');
  assert(await page.isDisabled('#undo-btn'), 'undo disabled at bottom of stack');
  assert(await page.isEnabled('#redo-btn'), 'redo enabled');
  await page.click('#redo-btn');
  approx(await S(() => window.__t.alphaIn(0, 0, 512, 512)), alphaAfterErase, 0, 'after redo');
  await blurFocus();
  await page.keyboard.press('Control+Shift+z');
  const full = await S(() => window.__t.alphaIn(0, 0, 512, 512));
  assert(full > alphaAfterErase, 'after ctrl+shift+z restore re-applied');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  approx(await S(() => window.__t.alphaIn(0, 0, 512, 512)), full, 0, 'after ctrl+y');
  assert(await page.isDisabled('#redo-btn'), 'redo disabled at top');
  // edit reflected in export canvas, not just cutout array
  const r = await exportActive([[50 / 511, 20 / 511]]);
  assert(r.pts[0][3] > 200, 'restored corner visible in export alpha=' + r.pts[0][3]);
  // back to pristine
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  approx(await S(() => window.__t.alphaIn(0, 0, 512, 512)), alphaBefore, 0, 'pristine after 2 undos');
});

await check('space held while brushing pans instead of erasing', async () => {
  await page.click('.tools [data-tool="erase"]');
  await blurFocus();
  const h0 = await S(() => window.__t.cutoutHash());
  const p0 = await S(() => ({ x: window.__obr.viewer.panX, y: window.__obr.viewer.panY }));
  await page.keyboard.down('Space');
  const a = await S(() => window.__t.toClient(256, 300));
  await drag(a, { x: a.x + 60, y: a.y + 30 });
  await page.keyboard.up('Space');
  const h1 = await S(() => window.__t.cutoutHash());
  const p1 = await S(() => ({ x: window.__obr.viewer.panX, y: window.__obr.viewer.panY }));
  assert(h0 === h1, 'cutout should be unchanged');
  assert(Math.abs(p1.x - p0.x - 60) < 2 && Math.abs(p1.y - p0.y - 30) < 2, `pan moved ${p1.x - p0.x},${p1.y - p0.y}`);
  await page.click('#zoom-fit');
  await page.click('.tools [data-tool="pan"]');
});

await check('pan tool drag moves the view', async () => {
  const a = await S(() => window.__t.toClient(256, 256));
  await drag(a, { x: a.x - 40, y: a.y + 25 });
  const v = await S(() => ({ x: window.__obr.viewer.panX, y: window.__obr.viewer.panY }));
  assert(Math.abs(v.x + 40) < 2 && Math.abs(v.y - 25) < 2, `pan ${v.x},${v.y}`);
  await page.click('#zoom-fit');
  const v2 = await S(() => ({ x: window.__obr.viewer.panX, y: window.__obr.viewer.panY, z: window.__obr.viewer.zoom }));
  assert(v2.x === 0 && v2.y === 0 && v2.z === 1, 'fit resets pan/zoom');
});

await check('compare toggle + split handle drag', async () => {
  await page.click('.tools [data-tool="erase"]');
  await page.click('#compare-btn');
  let v = await S(() => ({ c: window.__obr.viewer.compare, t: window.__obr.viewer.tool, s: window.__obr.viewer.split }));
  assert(v.c === true, 'compare on');
  assert(v.t === 'pan', 'compare switches to pan tool, got ' + v.t);
  assert(await page.getAttribute('#compare-btn', 'aria-pressed') === 'true', 'aria-pressed');
  await page.waitForTimeout(100);
  await shot('05-compare');
  const b = await page.locator('#view-canvas').boundingBox();
  const h0 = await S(() => window.__t.cutoutHash());
  await drag({ x: b.x + b.width * 0.5, y: b.y + b.height * 0.5 }, { x: b.x + b.width * 0.25, y: b.y + b.height * 0.5 });
  v = await S(() => ({ c: window.__obr.viewer.compare, s: window.__obr.viewer.split, px: window.__obr.viewer.panX }));
  approx(v.s, 0.25, 0.02, 'split');
  assert(v.px === 0, 'split drag should not pan');
  assert(h0 === await S(() => window.__t.cutoutHash()), 'split drag does not edit');
  await page.click('#compare-btn');
  assert(await S(() => window.__obr.viewer.compare) === false, 'compare off');
  assert(await page.getAttribute('#compare-btn', 'aria-pressed') === 'false', 'aria-pressed false');
});

await check('Original / Removed view tabs', async () => {
  await page.click('#view-original');
  assert(await S(() => window.__obr.viewer.view) === 'original', 'original');
  assert(await S(() => document.getElementById('view-original').classList.contains('on')), 'tab on');
  await page.click('#view-result');
  assert(await S(() => window.__obr.viewer.view) === 'result', 'result');
});

await check('zoom buttons, label, and wheel zoom', async () => {
  const lbl = async () => [await page.textContent('#zoom-fit'), Math.round(await S(() => window.__obr.viewer.displayScale()) * 100) + '%'];
  await page.click('#zoom-fit');
  const fitLbl = await lbl();
  assert(fitLbl[0] === fitLbl[1], 'fit label ' + fitLbl);
  await page.click('#zoom-in');
  approx(await S(() => window.__obr.viewer.zoom), 1.25, 1e-9, 'zoom in');
  let l = await lbl(); assert(l[0] === l[1] && l[0] !== fitLbl[0], 'label after zoom in ' + l);
  await page.click('#zoom-out'); await page.click('#zoom-out');
  approx(await S(() => window.__obr.viewer.zoom), 0.8, 1e-9, 'zoom out');
  l = await lbl(); assert(l[0] === l[1], 'label after zoom out ' + l);
  await page.click('#zoom-fit');
  assert((await page.textContent('#zoom-fit')) === fitLbl[0], 'label back to fit');
  const b = await page.locator('#view-canvas').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(100);
  const z = await S(() => window.__obr.viewer.zoom);
  assert(z > 1.2, 'wheel zoom ' + z);
  await page.click('#zoom-fit');
});

await check('keyboard shortcuts: E R H [ ] C O + - 0', async () => {
  await blurFocus();
  await S(() => window.__obr.viewer.resetView());
  const v = () => S(() => { const x = window.__obr.viewer; return { tool: x.tool, size: x.brushSize, compare: x.compare, view: x.view, zoom: x.zoom }; });
  await page.keyboard.press('e'); assert((await v()).tool === 'erase', 'E');
  assert(await S(() => document.querySelector('.tools [data-tool="erase"]').classList.contains('on')), 'erase button marked');
  await page.keyboard.press('r'); assert((await v()).tool === 'restore', 'R');
  await page.keyboard.press('h'); assert((await v()).tool === 'pan', 'H');
  const s0 = (await v()).size;
  await page.keyboard.press(']'); const s1 = (await v()).size; assert(s1 > s0, `] ${s0}->${s1}`);
  assert((await page.textContent('#brush-size-out')) === String(s1), 'brush size label');
  await page.keyboard.press('['); assert((await v()).size < s1, '[');
  await page.keyboard.press('c'); assert((await v()).compare === true, 'C on');
  await page.keyboard.press('c'); assert((await v()).compare === false, 'C off');
  await page.keyboard.press('o'); assert((await v()).view === 'original', 'O original');
  await page.keyboard.press('o'); assert((await v()).view === 'result', 'O back');
  await page.keyboard.press('+'); approx((await v()).zoom, 1.25, 1e-9, '+');
  await page.keyboard.press('-'); await page.keyboard.press('-'); approx((await v()).zoom, 0.8, 1e-9, '-');
  await page.keyboard.press('0'); approx((await v()).zoom, 1, 1e-9, '0');
  await page.keyboard.press('c'); assert((await v()).compare === true, 'C on again');
  await page.keyboard.press('e'); await page.keyboard.press('Escape');
  const ve = await v(); assert(ve.compare === false && ve.tool === 'pan', 'Escape leaves compare/brush: ' + JSON.stringify(ve));
});

await check('keyboard: Ctrl+S downloads', async () => {
  await blurFocus();
  const r = await download(() => page.keyboard.press('Control+s'));
  assert(r.name === 'astronaut-no-bg.png', r.name);
});

await check('sticky quick Download button downloads', async () => {
  assert(await page.isEnabled('#quick-dl-btn'), 'enabled');
  const r = await download(() => page.click('#quick-dl-btn'));
  assert(r.name === 'astronaut-no-bg.png', r.name);
});

await check('canvas keyboard: arrows pan the view when canvas focused', async () => {
  await page.focus('#view-canvas');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  const v = await S(() => ({ x: window.__obr.viewer.panX, y: window.__obr.viewer.panY }));
  assert(v.x === 30 && v.y === 30, 'pan ' + JSON.stringify(v));
  await page.click('#zoom-fit');
});

await check('shortcuts ignored while typing in an input', async () => {
  await page.focus('#url-input').catch(() => {});
  // url-input is hidden in workspace; use the custom colour? use a temporary input instead
  await S(() => { const i = document.createElement('input'); i.id = '__tmp'; document.body.append(i); i.focus(); });
  await page.keyboard.press('e');
  assert(await S(() => window.__obr.viewer.tool) === 'pan', 'tool unchanged while typing');
  await S(() => document.getElementById('__tmp').remove());
});

// ---------------------------------------------------------------- batch / inputs
await check('batch via "+ Add" file chooser (2 samples), processed sequentially', async () => {
  const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.click('#add-btn')]);
  // Track concurrency in page.
  await S(() => { window.__maxProc = 0; window.__procTimer = setInterval(() => { const n = window.__obr.state.items.filter((i) => i.status === 'processing').length; window.__maxProc = Math.max(window.__maxProc, n); }, 20); });
  await fc.setFiles([path.join(root, 'samples/chelsea.jpg'), path.join(root, 'samples/coffee.jpg')]);
  await page.waitForFunction(() => window.__obr.state.items.length === 3);
  await waitAllSettled();
  const maxProc = await S(() => { clearInterval(window.__procTimer); return window.__maxProc; });
  const its = await items();
  assert(its.every((i) => i.status === 'done'), JSON.stringify(its));
  assert(its.map((i) => i.name).join() === 'astronaut.jpg,chelsea.jpg,coffee.jpg', 'names ' + its.map((i) => i.name));
  assert(maxProc <= 1, 'max concurrent processing ' + maxProc);
  assert(await page.$$eval('#queue-list .qitem', (q) => q.length) === 3, 'queue DOM count');
  assert(await page.textContent('#zip-btn') === 'ZIP (3)', 'zip label ' + await page.textContent('#zip-btn'));
  assert((await page.$$eval('#queue-list .badge.done', (q) => q.length)) === 3, 'done badges');
  const act = await activeInfo();
  return `active stays ${act.name}`;
});

await check('arrow keys switch active image', async () => {
  await blurFocus();
  const n0 = (await activeInfo()).name;
  await page.keyboard.press('ArrowDown');
  const n1 = (await activeInfo()).name;
  assert(n1 !== n0, 'ArrowDown changed active');
  await page.keyboard.press('ArrowUp');
  assert((await activeInfo()).name === n0, 'ArrowUp back');
  assert(await S(() => window.__obr.viewer.item === window.__obr.state.active), 'viewer follows active');
});

await check('clicking a queue thumbnail selects it', async () => {
  await selectByName('chelsea.jpg');
  const a = await activeInfo();
  assert(a.name === 'chelsea.jpg', a.name);
  assert(/chelsea/.test(await S(() => document.querySelector('#queue-list .qitem.active .qsel').getAttribute('aria-label'))), 'active class');
  assert(await S(() => document.querySelector('#queue-list .qitem.active .qsel').getAttribute('aria-current')) === 'true', 'aria-current');
  await page.click('#queue-list .qitem:nth-child(1) .qsel');
  assert((await activeInfo()).name === 'astronaut.jpg', 'mouse click selects first');
  await selectByName('chelsea.jpg');
  assert(/451×300/.test(await page.textContent('#stage-info')), 'stage info dims');
});

await check('paste image (ClipboardEvent with File) adds & processes it', async () => {
  const fx = await makeFixture('small');
  await blurFocus();
  await S((b64) => {
    const f = new File([window.__t.b64ToBytes(b64)], 'image.png', { type: 'image/png' });
    const dt = new DataTransfer(); dt.items.add(f);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
  }, fx.buffer.toString('base64'));
  await page.waitForFunction(() => window.__obr.state.items.some((i) => /^pasted-/.test(i.name)), null, { timeout: 5000 });
  const r = await waitItem('pasted-');
  assert(r.status === 'done', JSON.stringify(r));
  assert(/^pasted-\d+-0\.png$/.test(r.name), 'renamed ' + r.name);
  assert(r.w === 320 && r.h === 240, 'dims');
});

await check('paste of a URL text loads it', async () => {
  await blurFocus();
  const n0 = (await items()).length;
  await S((u) => {
    const dt = new DataTransfer(); dt.setData('text/plain', u);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, base + 'samples/chelsea_thumb.jpg');
  await page.waitForFunction((n) => window.__obr.state.items.length === n + 1, n0, { timeout: 10000 });
  const r = await waitItem('chelsea_thumb.jpg');
  assert(r.status === 'done', JSON.stringify(r));
});

await check('drag & drop a file onto the window (overlay shows/hides)', async () => {
  const fx = await makeFixture('transparent');
  await S((b64) => {
    const f = new File([window.__t.b64ToBytes(b64)], 'transparent.png', { type: 'image/png' });
    window.__dt = new DataTransfer(); window.__dt.items.add(f);
    document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer: window.__dt, bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new DragEvent('dragover', { dataTransfer: window.__dt, bubbles: true, cancelable: true }));
  }, fx.buffer.toString('base64'));
  assert(await page.isVisible('#drop-overlay'), 'drop overlay visible on dragenter');
  await S(() => document.getElementById('stage').dispatchEvent(new DragEvent('drop', { dataTransfer: window.__dt, bubbles: true, cancelable: true })));
  assert(await page.isHidden('#drop-overlay'), 'overlay hidden after drop');
  const r = await waitItem('transparent.png');
  assert(r.status === 'done', JSON.stringify(r));
  assert(r.w === 1200 && r.h === 900, 'dims');
});

await check('drop of a non-image file shows toast', async () => {
  await S(() => {
    const dt = new DataTransfer(); dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await waitToast(/not an image/);
  assert(await page.isHidden('#drop-overlay'), 'overlay hidden');
  await hideToast();
});

await check('transparent PNG input: originally transparent pixels stay transparent in output', async () => {
  await selectByName('transparent.png');
  await page.selectOption('#size-select', 'full');
  const r = await exportActive([[0.05, 0.95], [0.04, 0.5], [0.75, 0.5], [0.2, 0.25]]);
  // (0.05,0.95) and (0.04,0.5) are fully transparent in the input; (0.75,0.5) is the red disc; (0.2,0.25) semi-transparent blue square.
  const [a, b, disc] = r.pts;
  assert(r.w === 1200 && r.h === 900, 'dims');
  assert(a[3] < 30 && b[3] < 30, `input-transparent region became alpha ${a[3]}/${b[3]} (rgb ${a.slice(0, 3)})`);
  return `disc alpha ${disc[3]}`;
});

await check('size options produce correct dims (1200x900 PNG: 1024 / 625 / 2048 / full)', async () => {
  const expect = { 1024: [1024, 768], 625: [625, 469], 2048: [1200, 900], full: [1200, 900] };
  const out = [];
  for (const [opt, [w, h]] of Object.entries(expect)) {
    await page.selectOption('#size-select', opt);
    const note = await page.textContent('#download-note');
    assert(note.startsWith(`${w} × ${h}`), `note for ${opt}: ${note}`);
    const r = await exportActive();
    assert(r.w === w && r.h === h, `${opt}: ${r.w}x${r.h} expected ${w}x${h}`);
    out.push(`${opt}=${r.w}x${r.h}`);
  }
  await page.selectOption('#size-select', 'full');
  return out.join(' ');
});

await check('URL load of same-origin image (coffee.jpg duplicate)', async () => {
  // URL form lives on the landing page; drive the same code path via paste-free route:
  // the form is hidden in workspace, so submit it programmatically.
  await S((u) => { document.getElementById('url-input').value = u; document.getElementById('url-form').requestSubmit(); }, base + 'samples/coffee.jpg');
  await page.waitForFunction(() => window.__obr.state.items.filter((i) => i.name === 'coffee.jpg').length === 2, null, { timeout: 10000 });
  await waitAllSettled();
  const its = await items();
  assert(its.every((i) => i.status === 'done'), JSON.stringify(its.filter((i) => i.status !== 'done')));
});

await check('apply settings to all copies bg/shadow/crop', async () => {
  await selectByName('chelsea.jpg');
  await page.click('.bg-types [data-bg="color"]');
  await page.click('.swatch[data-color="#000000"]');
  await openSect('sect-advanced');
  await page.click('#apply-all-btn');
  await waitToast(/applied/);
  const types = await S(() => window.__obr.state.items.map((i) => i.settings.bg.type + ':' + i.settings.bg.color));
  assert(types.every((t) => t === 'color:#000000'), types.join());
  const shared = await S(() => { const [a, b] = window.__obr.state.items; return a.settings.bg === b.settings.bg; });
  assert(!shared, 'settings objects should be copies');
  // reset all to transparent
  await page.click('.bg-types [data-bg="transparent"]');
  await page.click('#apply-all-btn');
  await hideToast();
});

await check('ZIP all: valid store-only zip, one PNG per done item, unique names, CRCs ok', async () => {
  await page.selectOption('#fmt-select', 'png');
  const its = await items();
  const done = its.filter((i) => i.status === 'done');
  assert(await page.textContent('#zip-btn') === `ZIP (${done.length})`, 'zip label ' + await page.textContent('#zip-btn'));
  const { name, buf } = await download(() => page.click('#zip-btn'), 120_000);
  assert(name === 'background-removed.zip', name);
  assert(buf.readUInt32LE(0) === 0x04034b50, 'local header signature at 0');
  const entries = parseZip(buf);
  assert(entries.length === done.length, `entries ${entries.length} vs done ${done.length}`);
  const names = entries.map((e) => e.name);
  assert(new Set(names).size === names.length, 'duplicate names: ' + names);
  assert(names.includes('coffee-no-bg.png') && names.includes('coffee-no-bg (2).png'), 'dedupe naming: ' + names.join(', '));
  for (const e of entries) {
    assert(e.method === 0 && e.csize === e.usize, `${e.name} store method`);
    assert(e.data.subarray(0, 8).equals(PNG_SIG), `${e.name} PNG signature`);
    assert(e.crcOk, `${e.name} CRC mismatch`);
  }
  const ast = entries.find((e) => e.name === 'astronaut-no-bg.png');
  const d = pngDims(ast.data);
  assert(d.w === 512 && d.h === 512, 'astronaut dims in zip');
  await page.waitForFunction(() => !document.getElementById('zip-btn').disabled);
  assert(/^ZIP (all|\(\d+\))$/.test(await page.textContent('#zip-btn')), 'zip button label restored: ' + await page.textContent('#zip-btn'));
  return names.join(', ');
});

await check('remove non-active item from queue', async () => {
  await selectByName('astronaut.jpg');
  const n0 = (await items()).length;
  await page.hover('#queue-list .qitem:nth-child(2)');
  const removedId = (await items())[1].id;
  await page.click('#queue-list .qitem:nth-child(2) .remove');
  const its = await items();
  assert(its.length === n0 - 1 && !its.some((i) => i.id === removedId), 'item not removed');
  assert(await page.$$eval('#queue-list .qitem', (q) => q.length) === n0 - 1, 'queue DOM count');
  assert((await activeInfo()).name === 'astronaut.jpg', 'active unchanged');
});

await check('remove ACTIVE item: next item becomes active and viewer follows (no errors)', async () => {
  const errs0 = logs.filter((l) => l.startsWith('[pageerror]')).length;
  await selectByName('astronaut.jpg');
  await page.hover('#queue-list .qitem.active');
  await page.click('#queue-list .qitem.active .remove');
  await page.waitForTimeout(300);
  const st = await S(() => ({ active: window.__obr.state.active?.name, viewerItem: window.__obr.viewer.item?.name, same: window.__obr.viewer.item === window.__obr.state.active }));
  const errs = logs.filter((l) => l.startsWith('[pageerror]')).slice(errs0);
  await shot('06-after-remove-active');
  assert(st.active && st.active !== 'astronaut.jpg', 'new active ' + st.active);
  // Is the stage actually showing the new active item? sample canvas centre.
  const blank = await S(() => { const c = document.getElementById('view-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) n++; return n === 0; });
  assert(st.same, `viewer.item (${st.viewerItem}) !== state.active (${st.active}); stage canvas blank=${blank}`);
  assert(errs.length === 0, 'page errors: ' + errs.join(' | '));
});

// ---------------------------------------------------------------- large image
await check('large 5000x4000 upload via file input is downscaled to <=16MP and processed', async () => {
  const fx = await makeFixture('large');
  await page.setInputFiles('#file-input', { name: 'large.jpg', ...fx });
  const r = await waitItem('large.jpg');
  assert(r.status === 'done', JSON.stringify(r));
  assert(r.downscaled === true, 'downscaled flag');
  assert(r.w * r.h <= 16_000_000 && Math.abs(r.w / r.h - 1.25) < 0.01, `dims ${r.w}x${r.h}`);
  await selectByName('large.jpg');
  assert(/downscaled/.test(await page.textContent('#stage-info')), 'stage-info mentions downscale');
  return `${r.w}x${r.h}, ${r.timings.total}ms (${JSON.stringify(r.timings)})`;
});

await check('large image export sizes (2048 / 1024 / 625 jpg, full png)', async () => {
  const it = await activeInfo();
  const out = [];
  await page.selectOption('#fmt-select', 'jpg');
  for (const m of [2048, 1024, 625]) {
    await page.selectOption('#size-select', String(m));
    const r = await exportActive();
    const ew = m, eh = Math.round(it.h * (m / it.w));
    assert(r.w === ew && r.h === eh, `${m}: ${r.w}x${r.h} expected ${ew}x${eh}`);
    out.push(`${m}=${r.w}x${r.h}`);
  }
  await page.selectOption('#fmt-select', 'png');
  await page.selectOption('#size-select', 'full');
  const r = await exportActive([[0.5, 0.3], [0.02, 0.02]]);
  assert(r.w === it.w && r.h === it.h, `full ${r.w}x${r.h} vs ${it.w}x${it.h}`);
  out.push(`full=${r.w}x${r.h} (${(r.buf.length / 1e6).toFixed(1)}MB)`);
  return out.join(' ');
});

await check('cancel a running job (overlay Cancel) drops item and engine recovers', async () => {
  await page.selectOption('#model-select', 'balanced');
  await hideToast();
  const n0 = (await items()).length;
  await S(async (u) => { const b = await (await fetch(u)).blob(); await window.__obr.addFiles([new File([b], 'cancel-me.jpg', { type: 'image/jpeg' })]); }, base + 'samples/chelsea.jpg');
  await selectByName('cancel-me.jpg');
  await page.waitForFunction(() => window.__obr.state.active.status === 'processing', null, { timeout: 10000 });
  await page.waitForSelector('#overlay-actions button', { timeout: 5000 });
  await page.click('#overlay-actions button:has-text("Cancel")');
  await page.waitForFunction((n) => window.__obr.state.items.length === n, n0, { timeout: 5000 });
  assert(!(await items()).some((i) => i.name === 'cancel-me.jpg'), 'cancelled item removed');
  assert(await S(() => window.__obr.state.busy) === false, 'not busy');
  await page.selectOption('#model-select', 'fast');
  await S(async (u) => { const b = await (await fetch(u)).blob(); await window.__obr.addFiles([new File([b], 'after-cancel.jpg', { type: 'image/jpeg' })]); }, base + 'samples/chelsea_thumb.jpg');
  const r = await waitItem('after-cancel.jpg');
  assert(r.status === 'done', 'processing after cancel: ' + JSON.stringify(r));
});

// ---------------------------------------------------------------- models & advanced
async function rerun() {
  await openSect('sect-advanced');
  await page.click('#reprocess-btn');
  await page.waitForFunction(() => window.__obr.state.active.status !== 'done', null, { timeout: 5000 }).catch(() => {});
  return waitActiveDone();
}
async function alphaSanity() {
  return S(() => {
    const it = window.__obr.state.active, d = it.cutout.data, w = it.width;
    const a = (x, y) => d[(y * w + x) * 4 + 3];
    return { tl: a(5, 5), tr: a(w - 6, 5), c: a(w >> 1, it.height >> 1) };
  });
}

await check('model switch shows toast; re-run with Balanced', async () => {
  await selectByName('astronaut.jpg').catch(() => {});
  // astronaut was removed above – re-add via sample (button lives on landing; use addFiles hook path through fetch)
  if ((await activeInfo()).name !== 'astronaut.jpg') {
    await S(async (u) => { const b = await (await fetch(u)).blob(); await window.__obr.addFiles([new File([b], 'astronaut.jpg', { type: 'image/jpeg' })]); }, base + 'samples/astronaut.jpg');
    await waitItem('astronaut.jpg');
    await selectByName('astronaut.jpg');
  }
  await page.selectOption('#model-select', 'balanced');
  await waitToast(/Switched to Balanced/);
  await hideToast();
  const a = await rerun();
  assert(a.model === 'balanced', a.model);
  assert(a.undo === 0 && a.redo === 0, 'undo cleared');
  const s = await alphaSanity();
  assert(s.tl < 25 && s.tr < 25 && s.c > 230, 'alpha ' + JSON.stringify(s));
  await shot('07-balanced');
  return `${a.backend} ${a.timings.total}ms ${JSON.stringify(a.timings)}`;
});

if (!process.env.ONLY_FAST) {
  await check('re-run with Best (fp16, split model parts)', async () => {
    await page.selectOption('#model-select', 'best');
    const a = await rerun();
    assert(a.model === 'best', a.model);
    const s = await alphaSanity();
    assert(s.tl < 25 && s.tr < 25 && s.c > 230, 'alpha ' + JSON.stringify(s));
    assert(/Best/.test(await page.textContent('#stage-info')), 'stage info label');
    await shot('08-best');
    return `${a.backend} ${a.timings.total}ms`;
  });
}

await check('refine toggle: off => cutout RGB equals original; on => edge colours adjusted', async () => {
  await page.selectOption('#model-select', 'fast');
  await openSect('sect-advanced');
  await page.uncheck('#refine-on');
  assert(await S(() => window.__obr.state.refine) === false, 'state.refine false');
  await rerun();
  const diffOff = await S(() => { const it = window.__obr.state.active, o = it.getOrigData().data, d = it.cutout.data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] !== o[i] || d[i + 1] !== o[i + 1] || d[i + 2] !== o[i + 2]) n++; return n; });
  await page.check('#refine-on');
  await rerun();
  const diffOn = await S(() => { const it = window.__obr.state.active, o = it.getOrigData().data, d = it.cutout.data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] !== o[i] || d[i + 1] !== o[i + 1] || d[i + 2] !== o[i + 2]) n++; return n; });
  assert(diffOff === 0, `refine off: ${diffOff} px differ from original`);
  assert(diffOn > 1000, `refine on: only ${diffOn} px differ`);
  return `differing px off=${diffOff} on=${diffOn}`;
});

await check('device=cpu runs on WASM', async () => {
  await page.selectOption('#device-select', 'cpu');
  assert(await S(() => window.__obr.state.device) === 'cpu', 'state.device');
  const a = await rerun();
  assert(/^wasm/.test(a.backend), 'backend ' + a.backend);
  return a.backend;
});

await check('device=gpu falls back gracefully when WebGPU unavailable', async () => {
  await page.selectOption('#device-select', 'gpu');
  const a = await rerun();
  const hasGpu = await S(async () => !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null)));
  assert(hasGpu ? /webgpu|wasm/.test(a.backend) : /^wasm/.test(a.backend), 'backend ' + a.backend);
  await page.selectOption('#device-select', 'auto');
  return `webgpu adapter=${hasGpu}, backend=${a.backend}`;
});

await check('preferences persist across reload (model/format/device/refine)', async () => {
  await page.selectOption('#fmt-select', 'webp');
  await page.selectOption('#model-select', 'best');
  await page.reload();
  await page.waitForFunction(() => !!window.__obr, null, { timeout: 15000 });
  assert(await page.inputValue('#model-select') === 'best', 'model persisted');
  assert(await S(() => window.__obr.state.format) === 'webp', 'format persisted');
  await page.selectOption('#model-select', 'fast');
  await S(() => localStorage.removeItem('obr-prefs'));
});

await check('removing every item returns to landing', async () => {
  // state was reset by the reload above: add two items again
  await page.click('.sample[data-src="samples/coffee.jpg"]');
  await page.waitForFunction(() => window.__obr.state.items.length === 1);
  await page.setInputFiles('#file-input', path.join(root, 'samples/chelsea.jpg'));
  await page.waitForFunction(() => window.__obr.state.items.length === 2);
  await waitAllSettled();
  while ((await items()).length) {
    const st = (await items())[0].status;
    if (st === 'processing' || st === 'queued') { await waitAllSettled(); continue; }
    await page.hover('#queue-list .qitem:first-child');
    await page.click('#queue-list .qitem:first-child .remove');
  }
  assert(await page.isVisible('#landing'), 'landing visible');
  assert(await page.isHidden('#workspace'), 'workspace hidden');
});

// ---------------------------------------------------------------- summary
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log('\n================ console / page errors & warnings ================');
console.log(logs.length ? [...new Set(logs)].join('\n') : '(none)');
console.log(`\n================ ${results.length - failed.length}/${results.length} passed ================`);
for (const f of failed) console.log(`FAIL ${f.name}: ${f.err}`);
process.exit(failed.length ? 1 : 0);
