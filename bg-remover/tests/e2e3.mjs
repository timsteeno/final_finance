// Round-3 regression checks (correctness + security review).
// Usage: node tests/e2e3.mjs [baseUrl]   (default http://localhost:8765/)
// Uses only the Fast model. Service workers are blocked so page.route() can
// intercept every request (including the inference worker's).
import { createRequire } from 'module';

const { chromium } = createRequire(import.meta.url)('playwright');
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

const browser = await chromium.launch();
async function newPage(setup) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, serviceWorkers: 'block' });
  await context.addInitScript(() => { try { localStorage.setItem('obr-prefs', JSON.stringify({ model: 'fast' })); } catch {} });
  if (setup) await setup(context);
  const page = await context.newPage();
  return { context, page };
}
const waitDone = (page, n = 0, timeout = 120000) => page.waitForFunction((n) => {
  const i = window.__obr?.state.items[n]; return i && (i.status === 'done' || i.status === 'error');
}, n, { timeout, polling: 200 });

// Parse the central directory of a store-only ZIP and return entry names.
function zipNames(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < n; i++) {
    const len = buf.readUInt16LE(p + 28), ex = buf.readUInt16LE(p + 30), cm = buf.readUInt16LE(p + 32);
    names.push(buf.subarray(p + 46, p + 46 + len).toString('utf8'));
    p += 46 + len + ex + cm;
  }
  return names;
}

const sampleBytes = await (await fetch(base + 'samples/chelsea.jpg')).arrayBuffer();

await check('?url= image whose path contains %2F does not produce path-traversal ZIP entries / download names', async () => {
  const { context, page } = await newPage(async (ctx) => {
    await ctx.route('**/evil/**', (r) => r.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from(sampleBytes), headers: { 'access-control-allow-origin': '*' } }));
  });
  const target = base + 'evil/..%2F..%2F..%2F..%2Ftmp%2Fpwned.jpg';
  await page.goto(base + '?url=' + encodeURIComponent(target));
  await waitDone(page);
  const name = await page.evaluate(() => window.__obr.state.items[0].name);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#zip-btn')]);
  const fs = await import('fs');
  const names = zipNames(fs.readFileSync(await dl.path()));
  await context.close();
  assert(!names.some((n) => n.includes('/') || n.includes('\\') || n.startsWith('..')), `item name "${name}" -> ZIP entries ${JSON.stringify(names)} (zip-slip: extracts outside the target folder)`);
});

await check('?url= with a malformed percent-escape in the path still loads the image', async () => {
  const { context, page } = await newPage(async (ctx) => {
    await ctx.route('**/evil/**', (r) => r.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from(sampleBytes) }));
  });
  await page.goto(base + '?url=' + encodeURIComponent(base + 'evil/100%25off%E0.jpg'));
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => ({ n: window.__obr.state.items.length, toast: document.getElementById('toast').textContent }));
  await context.close();
  assert(r.n === 1, `no item added; toast: "${r.toast}"`);
});

await check('a worker script that fails to load does not respawn in a tight loop', async () => {
  let hits = 0;
  const { context, page } = await newPage(async (ctx) => {
    await ctx.route('**/js/worker.js', (r) => { hits++; r.fulfill({ status: 404, body: 'nope' }); });
  });
  await page.goto(base);
  await page.waitForTimeout(3000);
  await context.close();
  assert(hits <= 3, `worker.js requested ${hits} times in 3 s (onerror -> startWorker -> onerror ...)`);
  return `${hits} loads`;
});

await check('a bad model download (HTTP 200 HTML page) is not cached forever', async () => {
  let poison = true;
  const { context, page } = await newPage(async (ctx) => {
    await ctx.route('**/models/u2netp.onnx', async (r) => {
      if (poison) return r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Not found</title>' });
      return r.continue();
    });
  });
  await page.goto(base);
  await page.waitForFunction(() => !!window.__obr);
  await page.evaluate(async () => { try { (await caches.keys()).forEach((k) => caches.delete(k)); } catch {} });
  await page.evaluate(async (u) => { const b = await (await fetch(u)).blob(); await window.__obr.addFiles([new File([b], 'a.jpg', { type: 'image/jpeg' })]); }, base + 'samples/chelsea.jpg');
  await waitDone(page, 0);
  const first = await page.evaluate(() => window.__obr.state.items[0].status);
  poison = false; // server fixed
  await page.evaluate(() => document.querySelector('#overlay-actions button').click()); // Try again
  await waitDone(page, 0);
  const second = await page.evaluate(() => [window.__obr.state.items[0].status, window.__obr.state.items[0].error]);
  await page.evaluate(async () => { try { (await caches.keys()).forEach((k) => caches.delete(k)); } catch {} });
  await context.close();
  assert(first === 'error', `expected first run to fail, got ${first}`);
  assert(second[0] === 'done', `after the server is fixed, retry still fails: ${second[1]}`);
});

// Synthetic test image: red disc on white; optional transparent hole.
async function addSynth(page, name, { hole = false } = {}) {
  await page.evaluate(async ([name, hole]) => {
    const c = new OffscreenCanvas(600, 400), x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 400);
    x.fillStyle = '#d22'; x.beginPath(); x.arc(300, 200, 120, 0, Math.PI * 2); x.fill();
    if (hole) x.clearRect(20, 20, 80, 80);
    const b = await c.convertToBlob({ type: 'image/png' });
    await window.__obr.addFiles([new File([b], name, { type: 'image/png' })]);
  }, [name, hole]);
}
const canvasPoint = (page, ix, iy) => page.evaluate(([ix, iy]) => {
  const v = window.__obr.viewer; const t = v._transform(); const b = v.canvas.getBoundingClientRect();
  return { x: b.left + (ix * t.s + t.ox) / v._dpr, y: b.top + (iy * t.s + t.oy) / v._dpr };
}, [ix, iy]);

await check('restore brush over input-transparent pixels keeps them transparent', async () => {
  const { context, page } = await newPage();
  await page.goto(base);
  await page.waitForFunction(() => !!window.__obr);
  await addSynth(page, 'hole.png', { hole: true });
  await waitDone(page);
  await page.keyboard.press('r');
  await page.evaluate(() => { window.__obr.viewer.brushSize = 200; window.__obr.viewer.hardness = 0.95; });
  const p = await canvasPoint(page, 60, 60);
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 2, p.y + 2); await page.mouse.up();
  const r = await page.evaluate(() => { const it = window.__obr.state.items[0], d = it.cutout.data, i = (60 * it.width + 60) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; });
  await context.close();
  assert(r[3] === 0, `input-transparent pixel became rgba(${r.join(',')}) after Restore`);
});

await check('with Crop to subject on, the view does not shift under the cursor during an erase stroke', async () => {
  const { context, page } = await newPage();
  await page.goto(base);
  await page.waitForFunction(() => !!window.__obr);
  await addSynth(page, 'disc.png');
  await waitDone(page);
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
  await page.check('#crop-on');
  await page.keyboard.press('e');
  await page.evaluate(() => { window.__obr.viewer.brushSize = 120; window.__obr.viewer.hardness = 0.95; });
  // Erase the left third of the disc, mouse held down the whole time.
  const a = await canvasPoint(page, 170, 120), b = await canvasPoint(page, 170, 280);
  const probeBefore = await page.evaluate(([x, y]) => window.__obr.viewer.toImage(x, y), [a.x, a.y]);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(a.x + 60 * (k % 2), a.y + (b.y - a.y) * k / 10);
  const probeDuring = await page.evaluate(([x, y]) => window.__obr.viewer.toImage(x, y), [a.x, a.y]);
  await page.mouse.up();
  await context.close();
  const d = Math.hypot(probeDuring.x - probeBefore.x, probeDuring.y - probeBefore.y);
  assert(d < 1, `screen point maps to image (${probeBefore.x.toFixed(1)},${probeBefore.y.toFixed(1)}) before the stroke and (${probeDuring.x.toFixed(1)},${probeDuring.y.toFixed(1)}) mid-stroke (${d.toFixed(1)} px drift)`);
});

await check('ZIP button stays disabled while a ZIP is being built (no double ZIP)', async () => {
  const { context, page } = await newPage();
  await page.goto(base);
  await page.waitForFunction(() => !!window.__obr);
  await addSynth(page, 'z1.png'); await addSynth(page, 'z2.png');
  await waitDone(page, 0); await waitDone(page, 1);
  let n = 0; page.on('download', () => n++);
  const midDisabled = await page.evaluate(() => {
    document.getElementById('zip-btn').click();
    // Any renderQueue() (item finishing, selecting an item, ...) while the ZIP is built:
    document.querySelectorAll('#queue-list .qsel')[0].click();
    const b = document.getElementById('zip-btn'); const d = b.disabled; b.click();
    return d;
  });
  await page.waitForTimeout(3000);
  await context.close();
  assert(midDisabled && n === 1, `zip button disabled mid-build: ${midDisabled}; ${n} ZIP downloads`);
});

await check('Re-run removal on one image while a ZIP is being built does not abort the ZIP', async () => {
  const { context, page } = await newPage();
  const errs = []; page.on('pageerror', (e) => { if (!/reading 'scope'/.test(e.message)) errs.push(e.message); }); // 'scope': coi-serviceworker under serviceWorkers:'block'
  await page.goto(base);
  await page.waitForFunction(() => !!window.__obr);
  await addSynth(page, 'r1.png'); await addSynth(page, 'r2.png');
  await waitDone(page, 0); await waitDone(page, 1);
  await page.evaluate(() => document.querySelectorAll('#queue-list .qsel')[1].click());
  let n = 0; page.on('download', () => n++);
  await page.evaluate(() => { document.getElementById('zip-btn').click(); document.getElementById('reprocess-btn').click(); });
  await page.waitForTimeout(3000);
  const toast = await page.evaluate(() => document.getElementById('toast').textContent);
  await context.close();
  assert(n === 1, `no ZIP saved; toast: "${toast}"`);
});

await check('adding an image (paste/drop) in the middle of a brush stroke does not throw', async () => {
  const { context, page } = await newPage();
  const errs = []; page.on('pageerror', (e) => { if (!/reading 'scope'/.test(e.message)) errs.push(e.message); }); // 'scope': coi-serviceworker under serviceWorkers:'block'
  await page.goto(base);
  await page.waitForFunction(() => !!window.__obr);
  await addSynth(page, 's1.png');
  await waitDone(page);
  await page.keyboard.press('e');
  const a = await canvasPoint(page, 300, 200);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x + 5, a.y);
  await addSynth(page, 's2.png'); // e.g. Ctrl+V while dragging
  await page.mouse.move(a.x + 40, a.y + 10); await page.mouse.up();
  const undo = await page.evaluate(() => window.__obr.state.items[0].undoStack.length);
  await context.close();
  assert(!errs.length && undo === 1, `page errors: ${JSON.stringify(errs)}; first image undo entries: ${undo}`);
});

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
