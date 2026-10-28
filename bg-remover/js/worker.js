// Inference worker: loads ONNX models, predicts an alpha matte for an image,
// upscales it to full resolution and estimates clean foreground colours.
import * as ort from '../vendor/ort/ort.webgpu.min.mjs';
import { MODELS } from './models.js';
import { estimateForeground } from './matting.js';
import { guidedUpscale } from './upscale.js';

const BASE = new URL('../', import.meta.url).href;
const CACHE_NAME = 'obr-models-v1';

ort.env.wasm.wasmPaths = BASE + 'vendor/ort/';
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))
  : 1;
ort.env.logLevel = 'error';

const sessions = new Map(); // key -> Promise<{session, backend}>

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

async function openCache() {
  try { return await caches.open(CACHE_NAME); } catch { return null; } // Cache API unavailable
}

async function evictModel(def) {
  const cache = await openCache();
  if (cache) for (const f of def.files) await cache.delete(BASE + f).catch(() => {});
}

async function fetchWithProgress(url, onBytes, cache) {
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const buf = await hit.arrayBuffer();
      onBytes(buf.byteLength);
      return { buf, cached: true };
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url} (HTTP ${res.status})`);
  if (/text\/html/i.test(res.headers.get('content-type') || '')) {
    throw new Error(`The server returned a web page instead of the model file ${url}. Check that the models/ folder was deployed.`);
  }
  let buf;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.byteLength;
      onBytes(value.byteLength);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.byteLength; }
    buf = out.buffer;
  } else {
    buf = await res.arrayBuffer();
    onBytes(buf.byteLength);
  }
  return { buf, cached: false };
}

async function loadModelBytes(model) {
  const def = MODELS[model];
  let loaded = 0;
  const report = (n) => {
    loaded += n;
    post({ type: 'progress', model, loaded, total: def.bytes });
  };
  const cache = await openCache();
  const parts = [];
  for (const f of def.files) parts.push(await fetchWithProgress(BASE + f, report, cache));
  const bufs = parts.map((p) => p.buf);
  const total = bufs.reduce((s, b) => s + b.byteLength, 0);
  if (total !== def.bytes) {
    await evictModel(def);
    throw new Error(`Model download is incomplete or corrupt (${total} of ${def.bytes} bytes). Please try again.`);
  }
  // Only cache once the whole model has the expected size.
  if (cache) {
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].cached) continue;
      try { await cache.put(BASE + def.files[i], new Response(bufs[i].slice(0))); } catch { /* quota */ }
    }
  }
  if (bufs.length === 1) return new Uint8Array(bufs[0]);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of bufs) { out.set(new Uint8Array(b), o); o += b.byteLength; }
  return out;
}

async function webgpuAvailable() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch { return false; }
}

function getSession(model, device) {
  const key = model + ':' + device;
  if (!sessions.has(key)) {
    const p = (async () => {
      const def = MODELS[model];
      const bytes = await loadModelBytes(model);
      const tryGpu = device === 'gpu' || (device === 'auto' && def.gpuFriendly && await webgpuAvailable());
      if (tryGpu) {
        try {
          const session = await ort.InferenceSession.create(bytes, {
            executionProviders: ['webgpu'],
            graphOptimizationLevel: 'all',
          });
          return { session, backend: 'webgpu' };
        } catch (e) {
          console.warn('WebGPU session failed, falling back to WASM', e);
        }
      }
      let session;
      try {
        session = await ort.InferenceSession.create(bytes, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });
      } catch (e) {
        // Unparseable bytes must not stay cached forever.
        await evictModel(def);
        throw e;
      }
      return { session, backend: 'wasm' + (ort.env.wasm.numThreads > 1 ? ` x${ort.env.wasm.numThreads}` : '') };
    })();
    p.catch(() => sessions.delete(key));
    sessions.set(key, p);
  }
  return sessions.get(key);
}

function makeCanvas(w, h) {
  return new OffscreenCanvas(w, h);
}

function preprocess(bitmap, def) {
  const s = def.size;
  const c = makeCanvas(s, s);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Transparent input pixels must look like background, not black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, s, s);
  ctx.drawImage(bitmap, 0, 0, s, s);
  const px = ctx.getImageData(0, 0, s, s).data;
  const n = s * s;
  const out = new Float32Array(3 * n);
  if (def.norm === 'isnet') {
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      out[j] = (px[i] - 128) / 256;
      out[j + n] = (px[i + 1] - 128) / 256;
      out[j + 2 * n] = (px[i + 2] - 128) / 256;
    }
  } else {
    // ImageNet mean/std after dividing by the image max (U^2-Net convention)
    let mx = 1;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > mx) mx = px[i];
      if (px[i + 1] > mx) mx = px[i + 1];
      if (px[i + 2] > mx) mx = px[i + 2];
    }
    const m = [0.485, 0.456, 0.406], sd = [0.229, 0.224, 0.225];
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      out[j] = (px[i] / mx - m[0]) / sd[0];
      out[j + n] = (px[i + 1] / mx - m[1]) / sd[1];
      out[j + 2 * n] = (px[i + 2] / mx - m[2]) / sd[2];
    }
  }
  // px is kept as the guide image for mask upsampling
  return { input: out, px };
}

function toMask8(data, def) {
  const n = data.length;
  const out = new Uint8ClampedArray(n);
  if (def.out === 'minmax') {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const d = Math.max(hi - lo, 1e-6);
    for (let i = 0; i < n; i++) out[i] = ((data[i] - lo) / d) * 255;
  } else {
    for (let i = 0; i < n; i++) out[i] = data[i] * 255;
  }
  return out;
}

// Remove small disconnected specks. Opaque components (>=128) are dropped if
// smaller than 0.5% of the largest one (or 0.1% when very confident). Soft
// pixels survive only if they connect to a kept component through pixels
// >= LOW (hysteresis, so whiskers and thin structures are kept), plus R px.
function removeIslands(mask, s, LOW = 32) {
  const n = s * s;
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  const sizes = [0], sums = [0];
  let cur = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i] < 128 || label[i]) continue;
    cur++;
    let sp = 0, size = 0, sum = 0;
    stack[sp++] = i; label[i] = cur;
    while (sp) {
      const p = stack[--sp];
      size++; sum += mask[p];
      const x = p % s, y = (p / s) | 0;
      if (x > 0 && !label[p - 1] && mask[p - 1] >= 128) { label[p - 1] = cur; stack[sp++] = p - 1; }
      if (x < s - 1 && !label[p + 1] && mask[p + 1] >= 128) { label[p + 1] = cur; stack[sp++] = p + 1; }
      if (y > 0 && !label[p - s] && mask[p - s] >= 128) { label[p - s] = cur; stack[sp++] = p - s; }
      if (y < s - 1 && !label[p + s] && mask[p + s] >= 128) { label[p + s] = cur; stack[sp++] = p + s; }
    }
    sizes.push(size); sums.push(sum);
  }
  if (cur === 0) return;
  let largest = 0;
  for (const z of sizes) if (z > largest) largest = z;
  const keepLabel = new Uint8Array(cur + 1);
  for (let l = 1; l <= cur; l++) {
    const z = sizes[l];
    keepLabel[l] = z >= largest * 0.005 || (z >= largest * 0.001 && sums[l] / z >= 220) ? 1 : 0;
  }
  const reach = new Uint8Array(n);
  let sp = 0;
  for (let i = 0; i < n; i++) {
    const l = label[i];
    if (!l) continue;
    if (keepLabel[l]) { reach[i] = 1; stack[sp++] = i; } else mask[i] = 0;
  }
  // grow through soft pixels >= LOW (8-connected)
  while (sp) {
    const p = stack[--sp];
    const x = p % s;
    for (let dy = -s; dy <= s; dy += s) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx === -1 && x === 0) || (dx === 1 && x === s - 1)) continue;
        const q = p + dy + dx;
        if (q < 0 || q >= n || reach[q] || mask[q] < LOW) continue;
        reach[q] = 1; stack[sp++] = q;
      }
    }
  }
  // dilate the reached region by R (separable) and clear everything outside
  const R = Math.max(2, Math.round(s / 160));
  const tmp = new Uint8Array(n), near = new Uint8Array(n);
  for (let y = 0; y < s; y++) {
    const row = y * s;
    let last = -1e9;
    for (let x = 0; x < s; x++) { if (reach[row + x]) last = x; if (x - last <= R) tmp[row + x] = 1; }
    last = 1e9;
    for (let x = s - 1; x >= 0; x--) { if (reach[row + x]) last = x; if (last - x <= R) tmp[row + x] = 1; }
  }
  for (let x = 0; x < s; x++) {
    let last = -1e9;
    for (let y = 0; y < s; y++) { if (tmp[y * s + x]) last = y; if (y - last <= R) near[y * s + x] = 1; }
    last = 1e9;
    for (let y = s - 1; y >= 0; y--) { if (tmp[y * s + x]) last = y; if (last - y <= R) near[y * s + x] = 1; }
  }
  for (let i = 0; i < n; i++) if (!near[i]) mask[i] = 0;
}

// Upscale the low-res mask to the image size with bilinear interpolation.
function upscaleMask(mask, ms, w, h) {
  const out = new Uint8ClampedArray(w * h);
  const sx = ms / w, sy = ms / h;
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    const y0 = Math.min(ms - 1, fy | 0), y1 = Math.min(ms - 1, y0 + 1), wy = fy - y0;
    const r0 = y0 * ms, r1 = y1 * ms;
    for (let x = 0; x < w; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      const x0 = Math.min(ms - 1, fx | 0), x1 = Math.min(ms - 1, x0 + 1), wx = fx - x0;
      const top = mask[r0 + x0] + (mask[r0 + x1] - mask[r0 + x0]) * wx;
      const bot = mask[r1 + x0] + (mask[r1 + x1] - mask[r1 + x0]) * wx;
      out[y * w + x] = top + (bot - top) * wy;
    }
  }
  return out;
}

async function run({ id, model, device, bitmap, refine }) {
  const def = MODELS[model];
  const t0 = performance.now();
  post({ type: 'status', id, stage: 'loading-model' });
  let { session, backend } = await getSession(model, device);
  post({ type: 'status', id, stage: 'inference', backend });
  const { input, px } = preprocess(bitmap, def);
  const tensor = new ort.Tensor('float32', input, [1, 3, def.size, def.size]);
  let results;
  try {
    results = await session.run({ [session.inputNames[0]]: tensor }, [session.outputNames[0]]);
  } catch (e) {
    if (backend !== 'webgpu') throw e;
    // Some GPUs/drivers fail at run time; retry on the CPU.
    console.warn('WebGPU inference failed, retrying on WASM', e);
    ({ session, backend } = await getSession(model, 'cpu'));
    post({ type: 'status', id, stage: 'inference', backend });
    results = await session.run({ [session.inputNames[0]]: tensor }, [session.outputNames[0]]);
  }
  const outT = results[session.outputNames[0]];
  const raw = outT.data instanceof Float32Array ? outT.data : Float32Array.from(outT.data);
  const mask = toMask8(raw, def);
  removeIslands(mask, def.size);
  for (const k in results) results[k].dispose?.();
  const t1 = performance.now();

  post({ type: 'status', id, stage: 'refining' });
  const w = bitmap.width, h = bitmap.height;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  let rgba = ctx.getImageData(0, 0, w, h).data;
  // Keep the input's own transparency; process its pixels over white so the
  // full-res guide matches what the model saw.
  let inA = null;
  for (let j = 3; j < rgba.length; j += 4) {
    if (rgba[j] < 255) { inA = true; break; }
  }
  if (inA) {
    inA = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 3; i < inA.length; i++, j += 4) inA[i] = rgba[j];
    ctx.fillStyle = '#ffffff';
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillRect(0, 0, w, h);
    rgba = ctx.getImageData(0, 0, w, h).data;
  }
  bitmap.close();
  // Edge-aware upsampling guided by the image, plus a contrast curve that
  // snaps near-opaque / near-clear values; plain bilinear when refine is off.
  const alpha = refine
    ? guidedUpscale(mask, def.size, px, rgba, w, h, 2, 1e-4, 0.04, 0.96)
    : upscaleMask(mask, def.size, w, h);
  if (refine) estimateForeground(rgba, alpha, w, h);
  if (inA) for (let i = 0; i < alpha.length; i++) alpha[i] = (alpha[i] * inA[i]) / 255;
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) rgba[j] = alpha[i];
  const t2 = performance.now();
  post({
    type: 'result', id, width: w, height: h, rgba: rgba.buffer, backend,
    timings: { inference: Math.round(t1 - t0), refine: Math.round(t2 - t1) },
  }, [rgba.buffer]);
}

// Tell the page the script loaded (and whether this browser can run it).
self.postMessage({
  type: 'hello',
  unsupported: typeof OffscreenCanvas === 'undefined' || !new OffscreenCanvas(1, 1).getContext('2d')
    ? 'This browser is too old to run the background-removal engine (needs OffscreenCanvas in workers, e.g. Safari 16.4+).'
    : '',
});

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'warmup') {
      const { backend } = await getSession(msg.model, msg.device);
      post({ type: 'ready', model: msg.model, backend });
    } else if (msg.type === 'run') {
      await run(msg);
    }
  } catch (err) {
    console.error(err);
    post({ type: 'error', id: msg.id, model: msg.model, message: String(err && err.message || err) });
  }
};
