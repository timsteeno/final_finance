// Offline test: visit once online (processing one image caches the app shell
// and the Fast model), then go offline, reload and process again.
// Usage: node tests/offline.mjs [baseUrl]
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://localhost:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
async function processSample() {
  await page.selectOption('#model-select', 'fast');
  await page.click('.sample[data-src="samples/coffee.jpg"]');
  await page.waitForFunction(() => ['done', 'error'].includes(window.__obr?.state.items[0]?.status), null, { timeout: 180000 });
  return page.evaluate(() => window.__obr.state.items[0].status + ' ' + window.__obr.state.items[0].error);
}
await page.goto(base);
await page.waitForTimeout(2500); // coi-serviceworker reload
const online = await processSample();
await page.waitForTimeout(1000); // let cache writes settle
await ctx.setOffline(true);
page.on('dialog', (d) => d.accept());
await page.evaluate(() => { window.onbeforeunload = null; });
await page.reload({ waitUntil: 'load' }).catch((e) => errors.push('reload: ' + e.message));
await page.waitForTimeout(1500);
const offline = await processSample();
console.log('online:', online, '| offline:', offline, '| errors:', errors);
await browser.close();
process.exit(online.startsWith('done') && offline.startsWith('done') ? 0 : 1);
