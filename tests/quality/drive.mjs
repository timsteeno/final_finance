// Quality driver: process images through the real browser pipeline and dump raw RGBA cutouts.
// Usage: node tests/quality/drive.mjs <model> <refine 0|1> <outDir> <img...>
// Writes <outDir>/<basename>.<model>.r<refine>.rgba (raw RGBA bytes) and a .json with w/h/timings.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const { chromium } = createRequire(import.meta.url)('playwright');
const [model, refine, outDir, ...imgs] = process.argv.slice(2);
const base = process.env.BASE || 'http://localhost:8765/';
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.text()); });
await page.goto(base);
await page.waitForLoadState('networkidle');
await page.waitForTimeout(1500);
await page.waitForFunction(() => !!window.__obr);
await page.evaluate(([m, r]) => { window.__obr.state.model = m; window.__obr.state.refine = r; }, [model, refine === '1']);
for (let k = 0; k < imgs.length; k++) {
  const f = imgs[k];
  await page.setInputFiles('#file-input', f);
  await page.waitForFunction((k) => {
    const i = window.__obr.state.items[k];
    return i && (i.status === 'done' || i.status === 'error');
  }, k, { timeout: 600000 });
  const meta = await page.evaluate((k) => {
    const i = window.__obr.state.items[k];
    return { status: i.status, error: i.error, w: i.width, h: i.height, timings: i.timings, backend: i.backend };
  }, k);
  const name = path.basename(f).replace(/\.[^.]+$/, '');
  const stem = path.join(outDir, `${name}.${model}.r${refine}`);
  if (meta.status === 'done') {
    // transfer in chunks as base64
    const total = meta.w * meta.h * 4, CH = 8 << 20;
    const fd = fs.openSync(stem + '.rgba', 'w');
    for (let o = 0; o < total; o += CH) {
      const b64 = await page.evaluate(([k, o, n]) => {
        const d = window.__obr.state.items[k].cutout.data.subarray(o, o + n);
        let s = '';
        for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
        return btoa(s);
      }, [k, o, CH]);
      fs.writeSync(fd, Buffer.from(b64, 'base64'));
    }
    fs.closeSync(fd);
  }
  fs.writeFileSync(stem + '.json', JSON.stringify(meta));
  console.log(name, JSON.stringify(meta));
}
await browser.close();
