// Run estimateForeground from a given module on raw buffers.
// Usage: node fg.mjs <module.js> <w> <h> <in.rgb(a) raw rgba> <alpha raw u8> <out.rgba> [extra JSON args]
import fs from 'fs';
import { pathToFileURL } from 'url';
const [mod, W, H, inp, alp, out, extra] = process.argv.slice(2);
const { estimateForeground } = await import(pathToFileURL(mod).href);
const w = +W, h = +H;
const rgba = new Uint8ClampedArray(fs.readFileSync(inp));
const alpha = new Uint8ClampedArray(fs.readFileSync(alp));
const args = extra ? JSON.parse(extra) : [];
const t = performance.now();
estimateForeground(rgba, alpha, w, h, ...args);
console.log(JSON.stringify({ ms: Math.round(performance.now() - t) }));
fs.writeFileSync(out, rgba);
