// Hibernation checks: inactive items free their pixels, edits survive a
// hibernate/wake round trip, and a batch stays within a memory budget.
// Usage: node tests/e2e4.mjs [baseUrl]
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://localhost:8765/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let pass = 0, fail = 0;
async function check(name, fn) {
  try { const note = await fn(); pass++; console.log(`PASS  ${name}${note ? '  — ' + note : ''}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const S = (fn, arg) => page.evaluate(fn, arg);

await page.goto(base);
await page.waitForTimeout(2000);
await page.selectOption('#model-select', 'fast');

// Generate N synthetic 3000x2000 photos in the page.
async function addSynthetic(n) {
  await S(async (n) => {
    const files = [];
    for (let k = 0; k < n; k++) {
      const c = document.createElement('canvas'); c.width = 3000; c.height = 2000;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 3000, 2000); g.addColorStop(0, `hsl(${k * 37},60%,80%)`); g.addColorStop(1, '#eee');
      x.fillStyle = g; x.fillRect(0, 0, 3000, 2000);
      x.fillStyle = `hsl(${k * 53},70%,40%)`; x.beginPath(); x.arc(1500, 1000, 600, 0, 7); x.fill();
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      files.push(new File([blob], `synthetic-${k}.jpg`, { type: 'image/jpeg' }));
    }
    window.__obr.addFiles(files);
  }, n);
  await page.waitForFunction(() => window.__obr.state.items.length && window.__obr.state.items.every((i) => i.status === 'done' || i.status === 'error'), null, { timeout: 600000 });
  await page.waitForTimeout(1500);
}

await check('batch of 10 × 6 MP: only the active item keeps decoded pixels', async () => {
  await addSynthetic(10);
  const st = await S(() => window.__obr.state.items.map((i) => ({ a: i === window.__obr.state.active, o: !!i.original, c: !!i.cutout, b: !!i.cutoutBlob, s: i.status })));
  assert(st.every((i) => i.s === 'done'), 'all done ' + JSON.stringify(st));
  const awake = st.filter((i) => !i.a && (i.o || i.c));
  assert(awake.length === 0, `${awake.length} inactive items still hold pixels`);
  assert(st.filter((i) => !i.a).every((i) => i.b), 'inactive items have PNG copies');
  const mem = await S(async () => (self.crossOriginIsolated && performance.measureUserAgentSpecificMemory ? (await performance.measureUserAgentSpecificMemory()).bytes : 0)).catch(() => 0);
  return mem ? `JS+DOM memory ${(mem / 1e6).toFixed(0)} MB` : '';
});

await check('edits survive hibernate → wake, and undo still works', async () => {
  const first = await S(() => window.__obr.state.items[0].id);
  // select item 0, erase a region via the API used by the brush
  await page.click(`.qitem[data-id="${first}"] .qsel`);
  await page.waitForFunction(() => { const a = window.__obr.state.active; return a.cutout && a.original; });
  const before = await S(() => {
    const it = window.__obr.state.active;
    it.beginStroke(); it.dab(1500, 1000, 200, 1, 'erase'); it.flush(1300, 800, 400, 400); it.endStroke();
    return it.cutout.data[(1000 * it.width + 1500) * 4 + 3];
  });
  assert(before === 0, 'erased centre alpha ' + before);
  const second = await S(() => window.__obr.state.items[1].id);
  await page.click(`.qitem[data-id="${second}"] .qsel`);
  await page.waitForFunction((id) => { const it = window.__obr.state.items.find((i) => i.id === id); return !it.cutout && !it.original && it.cutoutBlob; }, first, { timeout: 20000 });
  await page.click(`.qitem[data-id="${first}"] .qsel`);
  await page.waitForFunction(() => { const a = window.__obr.state.active; return a.cutout && a.original; });
  const after = await S(() => { const it = window.__obr.state.active; return { a: it.cutout.data[(1000 * it.width + 1500) * 4 + 3], undo: it.undoStack.length }; });
  assert(after.a === 0, 'edit lost after wake: ' + after.a);
  assert(after.undo === 1, 'undo entries ' + after.undo);
  await page.click('#undo-btn');
  const restored = await S(() => { const it = window.__obr.state.active; return it.cutout.data[(1000 * it.width + 1500) * 4 + 3]; });
  assert(restored > 200, 'undo after wake restores alpha, got ' + restored);
});

await check('ZIP of hibernated items contains every image', async () => {
  const dl = page.waitForEvent('download');
  await page.click('#zip-btn');
  const d = await dl;
  const buf = await (await import('fs')).promises.readFile(await d.path());
  let n = 0;
  for (let i = 0; i < buf.length - 4; i++) if (buf.readUInt32LE(i) === 0x02014b50) n++;
  const total = await S(() => window.__obr.state.items.length);
  assert(n === total, `zip entries ${n} vs items ${total}`);
  const awake = await S(() => window.__obr.state.items.filter((i) => i !== window.__obr.state.active && (i.original || i.cutout)).length);
  assert(awake === 0, `${awake} items left awake after ZIP`);
});

await check('no uncaught page errors', async () => { assert(!errors.length, errors.join(' | ')); });
console.log(`\n${pass}/${pass + fail} passed`);
await browser.close();
process.exit(fail ? 1 : 0);
