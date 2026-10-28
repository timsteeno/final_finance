// Inference worker: loads ONNX models, predicts an alpha matte for an image,
// upscales it to full resolution and estimates clean foreground colours.
import * as ort from '../vendor/ort/ort.webgpu.min.mjs';
import { MODELS } from './models.js';
import { estimateForeground } from './matting.js';

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

async function fetchWithProgress(url, onBytes) {
  let cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch { /* Cache API unavailable */ }
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const buf = await hit.arrayBuffer();
      onBytes(buf.byteLength);
      return buf;
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url} (HTTP ${res.status})`);
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
  if (cache) {
    try { await cache.put(url, new Response(buf.slice(0))); } catch { /* quota */ }
  }
  return buf;
}

async function loadModelBytes(model) {
  const def = MODELS[model];
  let loaded = 0;
  const report = (n) => {
    loaded += n;
    post({ type: 'progress', model, loaded, total: def.bytes });
  };
  const bufs = [];
  for (const f of def.files) bufs.push(await fetchWithProgress(BASE + f, report));
  if (bufs.length === 1) return new Uint8Array(bufs[0]);
  const total = bufs.reduce((s, b) => s + b.byteLength, 0);
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
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
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
  return out;
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
  const input = preprocess(bitmap, def);
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
  for (const k in results) results[k].dispose?.();
  const t1 = performance.now();

  post({ type: 'status', id, stage: 'refining' });
  const w = bitmap.width, h = bitmap.height;
  const alpha = upscaleMask(mask, def.size, w, h);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const img = ctx.getImageData(0, 0, w, h);
  const rgba = img.data;
  if (refine) estimateForeground(rgba, alpha, w, h);
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) rgba[j] = alpha[i];
  const t2 = performance.now();
  post({
    type: 'result', id, width: w, height: h, rgba: rgba.buffer, backend,
    timings: { inference: Math.round(t1 - t0), refine: Math.round(t2 - t1) },
  }, [rgba.buffer]);
}

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
