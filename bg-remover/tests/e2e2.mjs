// Round-2 regression checks (bugs found in the second adversarial test round).
// Usage: node tests/e2e2.mjs [baseUrl]   (default http://localhost:8765/)
// Uses only the Fast model; ~1 min. Each check is independent and prints PASS/FAIL.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { chromium } = createRequire(import.meta.url)('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const base = process.argv[2] || 'http://localhost:8765/';

const results = [];
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${note ? '  — ' + note : ''}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}

// ------------------------------------------------------------ unit: removeIslands
// Extract the worker's removeIslands verbatim and run it on synthetic masks.
const workerSrc = fs.readFileSync(path.join(root, 'js/worker.js'), 'utf8');
const fnSrc = workerSrc.match(/function removeIslands[\s\S]*?\n}\n/);
const removeIslands = fnSrc ? new Function(fnSrc[0] + '; return removeIslands;')() : null;

function synth(s) {
  const m = new Uint8ClampedArray(s * s);
  const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < s && y < s) m[y * s + x] = Math.max(m[y * s + x], v); };
  // body: opaque disc
  const cx = s / 2, cy = s / 2, R = s * 0.25;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < R * R) m[y * s + x] = 255;
  // whisker / antenna: 1px soft line (alpha 110) leaving the body for 0.12*s px
  for (let k = 0; k < s * 0.12; k++) set(Math.round(cx + R + k), Math.round(cy - k * 0.3), 110);
  // far-away faint haze blob (alpha 40), not connected to anything
  for (let y = 0; y < s * 0.05; y++) for (let x = 0; x < s * 0.05; x++) set(x + 4, y + 4, 40);
  return m;
}

await check('removeIslands: soft thin structure attached to the subject (whisker/antenna) survives', async () => {
  assert(removeIslands, 'removeIslands not found in worker.js');
  for (const s of [320, 1024]) {
    const m = synth(s);
    const cx = s / 2, R = s * 0.25;
    const before = [], idx = [];
    for (let k = Math.ceil(s * 0.03); k < s * 0.12; k++) { const i = Math.round(s / 2 - k * 0.3) * s + Math.round(cx + R + k); idx.push(i); before.push(m[i]); }
    removeIslands(m, s);
    const kept = idx.filter((i) => m[i] > 0).length;
    assert(kept / idx.length > 0.9, `size ${s}: only ${kept}/${idx.length} pixels of the attached soft line kept (whiskers/antennas/tower masts get cut off)`);
  }
});

await check('removeIslands: disconnected faint haze is still removed', async () => {
  assert(removeIslands, 'removeIslands not found');
  const s = 1024, m = synth(s);
  removeIslands(m, s);
  assert(m[10 * s + 10] === 0, 'haze blob not removed');
});

// ------------------------------------------------------------ browser
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base);
await page.waitForFunction(() => !!window.__obr);
const S = (fn, a) => page.evaluate(fn, a);
await page.selectOption('#model-select', 'fast');

const addBlob = (name, b64, type) => S(async ([n, b, t]) => {
  const u = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  await window.__obr.addFiles([new File([u], n, { type: t })]);
}, [name, b64, type]);
const addUrl = (name, url) => S(async ([n, u]) => { const b = await (await fetch(u)).blob(); await window.__obr.addFiles([new File([b], n, { type: b.type || 'image/jpeg' })]); }, [name, url]);
const waitName = (n, timeout = 120000) => page.waitForFunction((n) => { const i = window.__obr.state.items.find((x) => x.name === n); return i && (i.status === 'done' || i.status === 'error'); }, n, { timeout, polling: 200 });
const byName = (n) => S((n) => { const i = window.__obr.state.items.find((x) => x.name === n); return i && { status: i.status, error: i.error, w: i.width, h: i.height, modelUsed: i.modelUsed }; }, n);
const select = (n) => S((n) => { const st = window.__obr.state; const i = st.items.findIndex((x) => x.name === n); document.querySelectorAll('#queue-list .qitem .qsel')[i].click(); }, n);

await check('zoom label is never negative right after the first image is added', async () => {
  const p = addUrl('zoomlabel.jpg', base + 'samples/chelsea.jpg');
  await page.waitForFunction(() => window.__obr.state.items.length > 0);
  await page.waitForTimeout(200);
  const label = await S(() => document.getElementById('zoom-fit').textContent);
  await p;
  await waitName('zoomlabel.jpg');
  assert(!label.startsWith('-'), `zoom label shows "${label}" while the first image is processing (stale scale computed when the stage was hidden)`);
  return label;
});

await check('modelUsed / stage info reflect the model that actually ran when the model is switched mid-run', async () => {
  const p = addUrl('switch.jpg', base + 'samples/chelsea.jpg');
  await page.waitForFunction(() => window.__obr.state.items.find((x) => x.name === 'switch.jpg')?.status === 'processing', null, { timeout: 20000 });
  await page.selectOption('#model-select', 'balanced');
  await p;
  await waitName('switch.jpg');
  const r = await byName('switch.jpg');
  await page.selectOption('#model-select', 'fast');
  assert(r.modelUsed === 'fast', `processed with Fast but labelled "${r.modelUsed}"`);
});

await check('transparent pixels of an RGBA input stay transparent (hole inside subject, semi-transparent strip)', async () => {
  // 451x300 cat with a fully transparent 100x100 hole and a 50%-alpha strip on the left.
  const b64 = await S(async (u) => {
    const bmp = await createImageBitmap(await (await fetch(u)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d');
    x.drawImage(bmp, 0, 0);
    x.clearRect(200, 150, 100, 100);
    const d = x.getImageData(0, 0, 60, bmp.height); for (let i = 3; i < d.data.length; i += 4) d.data[i] = 128; x.putImageData(d, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const a = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
    return btoa(s);
  }, base + 'samples/chelsea.jpg');
  await addBlob('holes.png', b64, 'image/png');
  await waitName('holes.png');
  const r = await S(() => {
    const it = window.__obr.state.items.find((x) => x.name === 'holes.png'); const d = it.cutout.data, w = it.width;
    let holeMax = 0, stripMax = 0, sum = 0;
    for (let y = 150; y < 250; y++) for (let x = 200; x < 300; x++) holeMax = Math.max(holeMax, d[(y * w + x) * 4 + 3]);
    for (let y = 0; y < it.height; y++) for (let x = 0; x < 60; x++) stripMax = Math.max(stripMax, d[(y * w + x) * 4 + 3]);
    for (let i = 3; i < d.length; i += 4) sum += d[i];
    return { holeMax, stripMax, mean: sum / (d.length / 4) };
  });
  assert(r.holeMax === 0, `input-transparent hole has output alpha up to ${r.holeMax} (renders as an opaque black square)`);
  assert(r.stripMax <= 129, `50%-alpha input strip has output alpha up to ${r.stripMax}`);
  return JSON.stringify(r);
});

await check('SVG without width/height (viewBox only) can be loaded', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#eef"/><circle cx="200" cy="150" r="100" fill="#c33"/></svg>';
  await addBlob('viewbox.svg', Buffer.from(svg).toString('base64'), 'image/svg+xml');
  await waitName('viewbox.svg');
  const r = await byName('viewbox.svg');
  assert(r.status === 'done', `status ${r.status}: ${r.error}`);
});

await check('blur background + canvas aspect beyond the photo exports a fully opaque PNG', async () => {
  await select('zoomlabel.jpg');
  await S(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
  await page.click('.bg-types button[data-bg="blur"]');
  await page.selectOption('#crop-aspect', '9:16');
  await page.selectOption('#fmt-select', 'png');
  await page.selectOption('#size-select', 'full');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download-btn')]);
  const buf = fs.readFileSync(await dl.path());
  const r = await S(async (b64) => {
    const u = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([u], { type: 'image/png' }), { premultiplyAlpha: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
    const d = x.getImageData(0, 0, bmp.width, bmp.height).data; let n = 0, min = 255;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { n++; min = Math.min(min, d[i]); }
    return { w: bmp.width, h: bmp.height, nonOpaque: n, min };
  }, buf.toString('base64'));
  await page.selectOption('#crop-aspect', 'original');
  await page.click('.bg-types button[data-bg="transparent"]');
  assert(r.nonOpaque === 0, `${r.nonOpaque} non-opaque px (min alpha ${r.min}) in ${r.w}x${r.h} blurred-background PNG`);
});

await check('rapid double click on the sticky Download button saves one file', async () => {
  let n = 0;
  const on = () => n++;
  page.on('download', on);
  await S(() => { const b = document.getElementById('quick-dl-btn'); b.click(); b.click(); b.click(); });
  await page.waitForTimeout(3000);
  page.off('download', on);
  assert(n === 1, `${n} downloads from a triple click`);
});

await check('no uncaught page errors', async () => { assert(!errors.length, errors.join('\n')); });

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
