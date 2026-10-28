// Smoke test: load the page, process a sample, export PNG. Usage: node tests/smoke.mjs [baseUrl]
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://localhost:8765/';
const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(base);
await page.waitForLoadState('networkidle');
await page.waitForTimeout(1500); // coi-serviceworker may reload once
console.log('crossOriginIsolated:', await page.evaluate(() => self.crossOriginIsolated));
await page.click('.sample[data-src="samples/astronaut.jpg"]');
await page.waitForFunction(() => window.__obr?.state.items[0]?.status === 'done' || window.__obr?.state.items[0]?.status === 'error', null, { timeout: 180000 });
const info = await page.evaluate(() => { const i = window.__obr.state.items[0]; return { status: i.status, error: i.error, timings: i.timings, backend: i.backend }; });
console.log(info);
await page.screenshot({ path: process.env.SHOT || 'smoke.png' });
console.log(logs.join('\n'));
await browser.close();
