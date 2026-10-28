import { MODELS, DEFAULT_MODEL } from './models.js';
import { Item, MAX_PIXELS, composite, createCanvas, exportBlob, exportSize, outputName, FORMATS } from './editor.js';
import { Viewer } from './viewer.js';
import { makeZip } from './zip.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------- Preferences (best effort) ----------
const prefs = (() => {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('obr-prefs') || '{}'); } catch { /* ignore */ }
  return {
    get: (k, d) => (k in p ? p[k] : d),
    set: (k, v) => { p[k] = v; try { localStorage.setItem('obr-prefs', JSON.stringify(p)); } catch { /* ignore */ } },
  };
})();

const state = {
  items: [],
  active: null,
  // With a GPU the 88 MB fp16 model is fast and gives the cleanest masks.
  model: MODELS[prefs.get('model')] ? prefs.get('model') : ('gpu' in navigator ? 'best' : DEFAULT_MODEL),
  device: prefs.get('device', 'auto'),
  refine: prefs.get('refine', true),
  format: prefs.get('format', 'png'),
  size: prefs.get('size', 'full'),
  quality: prefs.get('quality', 92),
  busy: false,
};

// ---------- Worker ----------
let worker = null;
const pending = new Map();
let modelProgress = null; // {model, loaded, total}
const readyModels = new Set();

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === 'progress') {
    modelProgress = m;
    updateOverlay();
  } else if (m.type === 'status') {
    const p = pending.get(m.id);
    if (p) { p.item.stage = m.stage; if (m.stage !== 'loading-model') readyModels.add(p.model); updateOverlay(); }
  } else if (m.type === 'result') {
    const p = pending.get(m.id);
    pending.delete(m.id);
    p && p.resolve(m);
  } else if (m.type === 'error') {
    const p = pending.get(m.id);
    pending.delete(m.id);
    p && p.reject(new Error(m.message));
  }
}

function startWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => {
    console.error('worker error', e);
    toast('The processing engine failed to start: ' + (e.message || 'unknown error'), true);
    for (const p of pending.values()) p.reject(new Error('Worker crashed'));
    pending.clear();
    // Start a fresh engine so later jobs don't hang.
    worker.terminate();
    readyModels.clear();
    startWorker();
  };
}
startWorker();

// Abort the running job by restarting the worker (ORT runs can't be interrupted).
function cancelProcessing() {
  worker.terminate();
  const err = new Error('Cancelled');
  err.cancelled = true;
  for (const p of pending.values()) p.reject(err);
  pending.clear();
  readyModels.clear();
  modelProgress = null;
  startWorker();
}

let reqId = 0;
function runWorker(item, bitmap) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    const model = state.model;
    item.modelRunning = model;
    pending.set(id, { resolve: (r) => resolve({ ...r, model }), reject, item, model });
    worker.postMessage({ type: 'run', id, model, device: state.device, bitmap, refine: state.refine }, [bitmap]);
  });
}

// ---------- Image loading ----------
async function decode(blob) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // Fallback through <img> (e.g. SVG)
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      if (!img.naturalWidth || !img.naturalHeight || /svg/i.test(blob.type)) {
        // SVGs: rasterise at a useful size (viewBox-only SVGs have no intrinsic size)
        const nw = img.naturalWidth || 1024, nh = img.naturalHeight || 1024;
        const sc = Math.max(1, 2048 / Math.max(nw, nh));
        const c = createCanvas(Math.round(nw * sc), Math.round(nh * sc));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        bmp = await createImageBitmap(c);
      } else bmp = await createImageBitmap(img);
    } finally { URL.revokeObjectURL(url); }
  }
  let downscaled = false;
  if (bmp.width * bmp.height > MAX_PIXELS) {
    const s = Math.sqrt(MAX_PIXELS / (bmp.width * bmp.height));
    const w = Math.floor(bmp.width * s), h = Math.floor(bmp.height * s);
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    bmp = await createImageBitmap(c);
    downscaled = true;
  }
  return { bmp, downscaled };
}

function thumbOf(item) {
  const max = 160;
  const src = item.cutout ? item.outputRect() : { x: 0, y: 0, w: item.width, h: item.height };
  const s = Math.min(1, max / Math.max(src.w, src.h));
  const c = createCanvas(Math.max(1, Math.round(src.w * s)), Math.max(1, Math.round(src.h * s)));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(s, 0, 0, s, -src.x * s, -src.y * s);
  if (item.cutout) composite(ctx, item, s);
  else ctx.drawImage(item.original, 0, 0);
  return c.toDataURL('image/png');
}

function isImage(file) {
  return file && (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|svg|heic|heif|tiff?)$/i.test(file.name || ''));
}

async function addFiles(files) {
  const list = [...files].filter(isImage);
  if (!list.length) { if (files.length) toast('That file is not an image.', true); return; }
  showWorkspace();
  const added = [];
  for (const f of list) {
    const item = new Item(f);
    state.items.push(item);
    added.push(item);
  }
  if (!state.active || state.active.status === 'done') selectItem(added[0]);
  renderQueue();
  for (const item of added) {
    try {
      const { bmp, downscaled } = await decode(item.file);
      item.original = bmp;
      item.width = bmp.width;
      item.height = bmp.height;
      item.downscaled = downscaled;
      item.thumb = thumbOf(item);
    } catch (err) {
      item.status = 'error';
      item.error = /heic|heif/i.test(item.name) ? 'HEIC is not supported by this browser. Convert to JPG/PNG first.' : 'Could not read this image.';
    }
    renderQueue();
    if (item === state.active) refreshAll();
  }
  pump();
}

async function addFromUrl(url) {
  url = url.trim();
  if (!url) return;
  $('#toast').hidden = true;
  const btn = $('#url-form button');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    let res;
    try {
      res = await fetch(url, { mode: 'cors' });
    } catch {
      toast("Couldn't download that URL — the site may block cross-origin downloads. Save the image and upload it instead.", true);
      return;
    }
    if (!res.ok) { toast(`The server returned an error (HTTP ${res.status}).`, true); return; }
    const blob = await res.blob();
    if (blob.type && !blob.type.startsWith('image/')) { toast("That URL isn't an image.", true); return; }
    let name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || 'image');
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += '.' + ((blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg'));
    const file = new File([blob], name, { type: blob.type || 'image/png' });
    await addFiles([file]);
    $('#url-input').value = '';
  } catch (err) {
    toast("Couldn't load that URL: " + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load';
  }
}

// ---------- Processing queue ----------
async function pump() {
  if (state.busy) return;
  const next = state.items.find((i) => i.status === 'queued' && i.original);
  if (!next) return;
  state.busy = true;
  next.status = 'processing';
  next.stage = 'loading-model';
  next.startedAt = performance.now();
  renderQueue();
  if (next === state.active) refreshAll();
  try {
    const clone = await createImageBitmap(next.original);
    const t0 = performance.now();
    const r = await runWorker(next, clone);
    next.setCutout(r.rgba, r.width, r.height);
    next.backend = r.backend;
    next.timings = { ...r.timings, total: Math.round(performance.now() - t0) };
    next.status = 'done';
    next.modelUsed = r.model;
    next.thumb = thumbOf(next);
    if (next !== state.active) next.releaseCaches();
  } catch (err) {
    if (err.cancelled) {
      next.status = 'cancelled';
    } else {
      console.error(err);
      next.status = 'error';
      next.error = err.message || String(err);
      if (next === state.active) toast('Background removal failed: ' + next.error, true);
    }
  }
  state.busy = false;
  if (next.status === 'cancelled') {
    next.status = 'queued';
    dropItem(next);
  } else if (next.status === 'done' && next === state.active) {
    announce(state.items.some((i) => i.status === 'queued') ? 'Background removed.' : (matchMedia('(pointer: coarse)').matches ? 'Background removed. Tap Download to save.' : 'Background removed. Press Ctrl+S or Download to save.'));
  }
  renderQueue();
  if (next === state.active) refreshAll();
  pump();
}

// ---------- UI: queue ----------
function renderQueue() {
  const el = $('#queue-list');
  el.textContent = '';
  for (const item of state.items) {
    const b = document.createElement('div');
    b.className = 'qitem' + (item === state.active ? ' active' : '');
    b.dataset.id = item.id;
    const sel = document.createElement('button');
    sel.className = 'qsel';
    sel.setAttribute('aria-label', `${item.name} (${item.status})`);
    if (item === state.active) sel.setAttribute('aria-current', 'true');
    sel.addEventListener('click', () => selectItem(item));
    b.append(sel);
    if (item.thumb) {
      const img = document.createElement('img');
      img.src = item.thumb;
      img.alt = '';
      sel.append(img);
    }
    const badge = document.createElement('span');
    badge.className = 'badge ' + item.status;
    badge.textContent = { queued: 'Queued', processing: '…', done: '✓', error: '!' }[item.status];
    sel.append(badge);
    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.textContent = '✕';
    rm.title = item.status === 'processing' ? 'Cancel and remove' : 'Remove from list';
    rm.setAttribute('aria-label', 'Remove ' + item.name);
    rm.addEventListener('click', (e) => { e.stopPropagation(); removeItem(item); });
    b.append(rm);
    el.append(b);
  }
  const doneCount = state.items.filter((i) => i.status === 'done').length;
  $('#zip-btn').disabled = doneCount < 1;
  $('#zip-btn').textContent = doneCount > 1 ? `ZIP (${doneCount})` : 'ZIP all';
}

function removeItem(item) {
  if (item.status === 'processing') { cancelProcessing(); return; } // pump() drops it
  dropItem(item);
}

function dropItem(item) {
  const idx = state.items.indexOf(item);
  if (idx < 0) return;
  state.items.splice(idx, 1);
  item.original?.close?.();
  if (state.active === item) {
    const next = state.items[Math.min(idx, state.items.length - 1)] || null;
    if (!next) { state.active = null; showLanding(); return; }
    selectItem(next);
    return;
  }
  renderQueue();
  refreshAll();
}

function selectItem(item) {
  if (state.active && state.active !== item) state.active.releaseCaches();
  state.active = item;
  viewer.setItem(item);
  renderQueue();
  refreshAll();
}

// ---------- UI: workspace ----------
function showWorkspace() {
  $('#landing').hidden = true;
  $('#workspace').hidden = false;
}
function showLanding() {
  $('#landing').hidden = false;
  $('#workspace').hidden = true;
  viewer.setItem(null);
}

function updateOverlay() {
  const item = state.active;
  const ov = $('#stage-overlay');
  const actions = $('#overlay-actions');
  const sub = $('#overlay-sub');
  if (!item || (item.status !== 'processing' && item.status !== 'queued' && item.status !== 'error')) {
    ov.hidden = true;
    clearInterval(updateOverlay._timer); updateOverlay._timer = 0;
    return;
  }
  ov.hidden = false;
  const actionKey = item.id + ':' + item.status;
  if (actions.dataset.key !== actionKey) {
    actions.dataset.key = actionKey;
    actions.textContent = '';
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'btn small'; b.type = 'button'; b.textContent = label;
      b.addEventListener('click', fn);
      actions.append(b);
    };
    if (item.status === 'error') {
      if (item.original) mk('Try again', () => { item.status = 'queued'; item.error = ''; renderQueue(); refreshAll(); pump(); });
      mk('Remove', () => removeItem(item));
      mk('Upload another', () => $('#file-input').click());
    } else {
      mk('Cancel', () => removeItem(item));
    }
  }
  if (item.status === 'processing' && !updateOverlay._timer) {
    updateOverlay._timer = setInterval(updateOverlay, 500);
  }
  const queue = state.items.filter((i) => i.status === 'queued' || i.status === 'processing' || i.status === 'done');
  const pos = queue.indexOf(item) + 1;
  const parts = [];
  if (state.items.length > 1 && item.status !== 'error') parts.push(`Image ${pos} of ${queue.length}`);
  if (item.status === 'processing' && item.startedAt) parts.push(`${((performance.now() - item.startedAt) / 1000).toFixed(0)} s`);
  sub.textContent = parts.join(' · ');
  const spinner = ov.querySelector('.spinner');
  spinner.hidden = item.status === 'error';
  const prog = $('#overlay-progress');
  prog.hidden = true;
  let text = 'Waiting in queue…';
  if (item.status === 'error') text = '⚠ ' + item.error;
  else if (!item.original) text = 'Reading image…';
  else if (item.status === 'processing') {
    if (item.stage === 'loading-model') {
      const running = item.modelRunning || state.model;
      const def = MODELS[running];
      if (modelProgress && modelProgress.model === running && modelProgress.loaded < modelProgress.total) {
        const pct = Math.round((modelProgress.loaded / modelProgress.total) * 100);
        text = `Downloading ${def.label} model (${(def.bytes / 1e6).toFixed(0)} MB, one-time)… ${pct}%`;
        prog.hidden = false;
        prog.setAttribute('aria-valuenow', pct);
        $('#overlay-bar').style.width = pct + '%';
      } else text = readyModels.has(running) ? 'Removing background…' : 'Starting AI engine…';
    } else if (item.stage === 'inference') text = 'Removing background…';
    else if (item.stage === 'refining') text = 'Refining edges…';
  }
  const ot = $('#overlay-text');
  if (ot.textContent !== text) ot.textContent = text;
}

function refreshAll() {
  const item = state.active;
  viewer.render();
  updateOverlay();
  syncToolbar();
  syncPanel();
  const info = $('#stage-info');
  if (!item) { info.textContent = ''; return; }
  const parts = [`${item.name}`];
  if (item.width) parts.push(`${item.width}×${item.height}`);
  if (item.downscaled) parts.push('downscaled to fit browser limits');
  if (item.status === 'done' && item.timings) parts.push(`${MODELS[item.modelUsed]?.label || ''} · ${item.backend} · ${(item.timings.total / 1000).toFixed(1)}s`);
  info.textContent = parts.join(' · ');
}

function syncToolbar() {
  const item = state.active;
  const done = item && item.status === 'done';
  $('#view-original').classList.toggle('on', viewer.view === 'original');
  $('#view-result').classList.toggle('on', viewer.view === 'result');
  $('#view-original').setAttribute('aria-pressed', String(viewer.view === 'original'));
  $('#view-result').setAttribute('aria-pressed', String(viewer.view === 'result'));
  $('#quick-dl-btn').disabled = !done;
  $('#view-result').disabled = !done;
  $('#compare-btn').setAttribute('aria-pressed', String(viewer.compare));
  $('#compare-btn').disabled = !done;
  $('#undo-btn').disabled = !done || !item.undoStack.length;
  $('#redo-btn').disabled = !done || !item.redoStack.length;
  $('#zoom-fit').textContent = item && item.width ? Math.round(viewer.displayScale() * 100) + '%' : 'Fit';
}

function syncPanel() {
  const item = state.active;
  const done = item && item.status === 'done';
  $$('.panel button, .panel input, .panel select').forEach((el) => {
    if (el.closest('#sect-advanced') && el.id !== 'reprocess-btn' && el.id !== 'apply-all-btn') return;
    el.disabled = !done;
  });
  $('#reprocess-btn').disabled = !item || !item.original || item.status === 'processing' || item.status === 'queued';
  $('#apply-all-btn').disabled = !done || state.items.length < 2;
  $('#fmt-select').value = state.format;
  $('#size-select').value = state.size;
  $('#quality-row').hidden = state.format === 'png';
  $('#quality-range').value = state.quality;
  $('#quality-out').textContent = state.quality;
  $('#refine-on').checked = state.refine;
  $('#device-select').value = state.device;
  if (!item) return;
  const s = item.settings;
  $$('.bg-types button').forEach((b) => {
    const on = b.dataset.bg === s.bg.type;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  $('#bg-color-sub').hidden = s.bg.type !== 'color';
  $('#bg-image-sub').hidden = s.bg.type !== 'image';
  $('#bg-blur-sub').hidden = s.bg.type !== 'blur';
  if (/^#[0-9a-f]{6}$/i.test(s.bg.color)) $('#bg-color').value = s.bg.color;
  $$('.swatch').forEach((sw) => {
    const on = s.bg.type === 'color' && sw.dataset.color === s.bg.color;
    sw.classList.toggle('on', on);
    sw.setAttribute('aria-pressed', String(on));
  });
  $('#bg-image-name').textContent = s.bg.imageName || 'No photo chosen';
  $('#bg-blur').value = s.bg.blur;
  $('#bg-blur-out').textContent = s.bg.blur;
  $('#shadow-op-out').textContent = Math.round(s.shadow.opacity * 100);
  $('#shadow-blur-out').textContent = s.shadow.blur;
  $('#shadow-x-out').textContent = s.shadow.x;
  $('#shadow-y-out').textContent = s.shadow.y;
  $('#shadow-on').checked = s.shadow.enabled;
  $('#shadow-op').value = Math.round(s.shadow.opacity * 100);
  $('#shadow-blur').value = s.shadow.blur;
  $('#shadow-x').value = s.shadow.x;
  $('#shadow-y').value = s.shadow.y;
  ['#shadow-op', '#shadow-blur', '#shadow-x', '#shadow-y'].forEach((id) => { if (done) $(id).disabled = !s.shadow.enabled; });
  $('#crop-on').checked = s.crop.enabled;
  $('#crop-pad').value = s.crop.padding;
  if (done) $('#crop-pad').disabled = !s.crop.enabled;
  $('#crop-pad-out').textContent = s.crop.padding + '%';
  $('#crop-aspect').value = s.crop.aspect || 'original';
  $('#stage-tools').hidden = !done;
  $('#tray-size').value = Math.min(200, viewer.brushSize);
  $('#tray-undo').disabled = !done || !item.undoStack.length;
  $$('.stage-tools [data-tool]').forEach((b) => {
    b.classList.toggle('on', b.dataset.tool === viewer.tool);
    b.setAttribute('aria-pressed', String(b.dataset.tool === viewer.tool));
  });
  $$('.tools button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tool === viewer.tool);
    b.setAttribute('aria-checked', String(b.dataset.tool === viewer.tool));
  });
  $('#brush-size').value = viewer.brushSize;
  $('#brush-size-out').textContent = viewer.brushSize;
  $('#brush-hard').value = Math.round(viewer.hardness * 100);
  $('#brush-hard-out').textContent = Math.round(viewer.hardness * 100);
  if (done) {
    const { w, h } = exportSize(item, state.size);
    const bgNote = s.bg.type === 'transparent'
      ? (state.format === 'jpg' ? 'white background' : 'transparent')
      : `${{ color: 'color', image: 'photo', blur: 'blurred' }[s.bg.type]} background`;
    $('#download-note').textContent = `${w} × ${h} px · ${FORMATS[state.format].label} · ${bgNote}`;
  } else $('#download-note').textContent = '';
}

// Called after any setting changes that affect the composite.
function settingsChanged({ thumb = true } = {}) {
  const item = state.active;
  if (!item) return;
  viewer.render();
  syncPanel();
  if (thumb && item.status === 'done') {
    clearTimeout(settingsChanged._t);
    settingsChanged._t = setTimeout(() => { item.thumb = thumbOf(item); renderQueue(); }, 250);
  }
}

// ---------- Downloads ----------
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

let downloading = false;
async function downloadActive() {
  if (downloading) return;
  const item = state.active;
  if (!item || item.status !== 'done') { if (item) toast('Nothing to download yet — the background is still being removed.'); return; }
  const btn = $('#download-btn');
  downloading = true;
  btn.disabled = true;
  $('#quick-dl-btn').disabled = true;
  btn.textContent = 'Preparing…';
  item.downloaded = true;
  try {
    const blob = await exportBlob(item, { format: state.format, size: state.size, quality: state.quality / 100 });
    saveBlob(blob, outputName(item, state.format));
  } catch (err) {
    toast(err.message, true);
  } finally {
    downloading = false;
    btn.disabled = false;
    $('#quick-dl-btn').disabled = false;
    btn.textContent = 'Download';
  }
}

async function downloadZip() {
  const done = state.items.filter((i) => i.status === 'done');
  if (!done.length) return;
  const btn = $('#zip-btn');
  btn.disabled = true;
  const files = [];
  try {
    for (let i = 0; i < done.length; i++) {
      btn.textContent = `${i + 1}/${done.length}…`;
      const blob = await exportBlob(done[i], { format: state.format, size: state.size, quality: state.quality / 100 });
      files.push({ name: outputName(done[i], state.format), data: new Uint8Array(await blob.arrayBuffer()) });
      if (done[i] !== state.active) done[i].releaseCaches();
    }
    saveBlob(makeZip(files), 'background-removed.zip');
  } catch (err) {
    toast(err.message, true);
  } finally {
    renderQueue();
  }
}

// Screen-reader announcement (reuses the toast for sighted users).
function announce(msg) { toast(msg); }

// ---------- Toast ----------
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, error ? 6000 : 3000);
}

// ---------- Wiring ----------
const viewer = new Viewer($('#view-canvas'), {
  onChange: (what) => {
    syncToolbar();
    if (what === 'edit' && state.active) {
      state.active.thumb = thumbOf(state.active);
      renderQueue();
      syncPanel();
    }
  },
});

function initModelSelect() {
  const sel = $('#model-select');
  for (const [k, m] of Object.entries(MODELS)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = `${m.label} — ${m.description.split('·')[1].trim()}`;
    o.title = m.description;
    sel.append(o);
  }
  sel.value = state.model;
  sel.addEventListener('change', () => {
    state.model = sel.value;
    prefs.set('model', state.model);
    const item = state.active;
    if (item && item.status === 'done' && item.modelUsed !== state.model) {
      toast(`Switched to ${MODELS[state.model].label}. Use “Re-run removal” in Advanced to reprocess this image.`);
    }
  });
}

const SWATCHES = ['#ffffff', '#000000', '#f2f2f2', '#ff5a5f', '#ffb400', '#3ddc97', '#00a6fb', '#7b61ff',
  '#ffe3e3', '#fff3c4', '#d3f9d8', '#d0ebff', '#e5dbff', '#2b2d42', '#8d99ae', '#ff8fab',
  '#fdfbfb>#ebedee', '#a1c4fd>#c2e9fb', '#ffecd2>#fcb69f', '#84fab0>#8fd3f4',
  '#fbc2eb>#a6c1ee', '#f6d365>#fda085', '#667eea>#764ba2', '#232526>#414345'];

function initPanel() {
  const sw = $('#swatches');
  for (const c of SWATCHES) {
    const b = document.createElement('button');
    b.className = 'swatch';
    const st = c.split('>');
    b.style.background = st.length === 2 ? `linear-gradient(135deg, ${st[0]}, ${st[1]})` : c;
    b.dataset.color = c;
    b.title = c.replace('>', ' → ');
    b.setAttribute('aria-label', (c.includes('>') ? 'Gradient background ' : 'Background color ') + c.replace('>', ' to '));
    b.addEventListener('click', () => {
      const s = state.active.settings.bg;
      s.type = 'color'; s.color = c;
      settingsChanged();
    });
    sw.append(b);
  }
  $$('.bg-types button').forEach((b) => b.addEventListener('click', () => {
    const s = state.active.settings.bg;
    s.type = b.dataset.bg;
    if (s.type === 'image' && !s.image) $('#bg-file-input').click();
    settingsChanged();
  }));
  $('#bg-color').addEventListener('input', (e) => {
    const s = state.active.settings.bg;
    s.type = 'color'; s.color = e.target.value;
    settingsChanged();
  });
  $('#bg-image-btn').addEventListener('click', () => $('#bg-file-input').click());
  $('#bg-file-input').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f || !state.active) return;
    try {
      const { bmp } = await decode(f);
      const s = state.active.settings.bg;
      s.type = 'image'; s.image = bmp; s.imageName = f.name;
      settingsChanged();
    } catch { toast('Could not read that background image.', true); }
  });
  $('#bg-blur').addEventListener('input', (e) => { state.active.settings.bg.blur = +e.target.value; settingsChanged(); });

  $$('.tools button, .stage-tools [data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool, { fromTray: !!b.closest('.stage-tools') })));
  $('#tray-size').addEventListener('input', (e) => { viewer.brushSize = +e.target.value; syncPanel(); });
  $('#tray-undo').addEventListener('click', () => undo());
  $('#brush-size').addEventListener('input', (e) => { viewer.brushSize = +e.target.value; $('#brush-size-out').textContent = viewer.brushSize; });
  $('#brush-hard').addEventListener('input', (e) => { viewer.hardness = +e.target.value / 100; $('#brush-hard-out').textContent = e.target.value; });

  $('#shadow-on').addEventListener('change', (e) => { state.active.settings.shadow.enabled = e.target.checked; settingsChanged(); });
  $('#shadow-op').addEventListener('input', (e) => { state.active.settings.shadow.opacity = +e.target.value / 100; settingsChanged(); });
  $('#shadow-blur').addEventListener('input', (e) => { state.active.settings.shadow.blur = +e.target.value; settingsChanged(); });
  $('#shadow-x').addEventListener('input', (e) => { state.active.settings.shadow.x = +e.target.value; settingsChanged(); });
  $('#shadow-y').addEventListener('input', (e) => { state.active.settings.shadow.y = +e.target.value; settingsChanged(); });

  $('#crop-on').addEventListener('change', (e) => { state.active.settings.crop.enabled = e.target.checked; viewer.resetView(); settingsChanged(); });
  $('#crop-pad').addEventListener('input', (e) => { state.active.settings.crop.padding = +e.target.value; settingsChanged(); });
  $('#crop-aspect').addEventListener('change', (e) => { state.active.settings.crop.aspect = e.target.value; viewer.resetView(); settingsChanged(); });

  $('#fmt-select').addEventListener('change', (e) => { state.format = e.target.value; prefs.set('format', state.format); syncPanel(); });
  $('#size-select').addEventListener('change', (e) => { state.size = e.target.value; prefs.set('size', state.size); syncPanel(); });
  $('#quality-range').addEventListener('input', (e) => { state.quality = +e.target.value; prefs.set('quality', state.quality); $('#quality-out').textContent = state.quality; });
  $('#download-btn').addEventListener('click', downloadActive);

  $('#refine-on').addEventListener('change', (e) => { state.refine = e.target.checked; prefs.set('refine', state.refine); });
  $('#device-select').addEventListener('change', (e) => { state.device = e.target.value; prefs.set('device', state.device); });
  $('#reprocess-btn').addEventListener('click', () => {
    const item = state.active;
    if (!item || !item.original || item.status === 'processing') return;
    item.status = 'queued';
    item.cutout = null; item.cutoutCanvas = null;
    item.undoStack = []; item.redoStack = [];
    viewer.view = 'result';
    renderQueue();
    refreshAll();
    pump();
  });
  $('#apply-all-btn').addEventListener('click', () => {
    const src = state.active.settings;
    for (const it of state.items) {
      if (it === state.active) continue;
      it.settings = {
        bg: { ...src.bg }, shadow: { ...src.shadow }, crop: { ...src.crop },
      };
      it._blurCache = null;
      if (it.status === 'done') { it.thumb = thumbOf(it); it.releaseCaches(); }
    }
    renderQueue();
    toast('Settings applied to all images.');
  });
}

function setTool(tool, { fromTray = false } = {}) {
  viewer.tool = tool;
  if (tool !== 'pan') {
    viewer.view = 'result';
    viewer.compare = false;
    if (!fromTray) $('#sect-brush').open = true;
  }
  syncPanel();
  syncToolbar();
  viewer.render();
}

function initToolbar() {
  $$('.toolbar [data-view]').forEach((b) => b.addEventListener('click', () => {
    viewer.view = b.dataset.view;
    if (viewer.view === 'original') viewer.compare = false;
    viewer.resetView();
    syncToolbar();
  }));
  $('#compare-btn').addEventListener('click', () => {
    viewer.compare = !viewer.compare;
    if (viewer.compare) { viewer.view = 'result'; viewer.split = 0.5; if (viewer.tool !== 'pan') setTool('pan'); }
    viewer.render();
    syncToolbar();
  });
  $('#undo-btn').addEventListener('click', undo);
  $('#redo-btn').addEventListener('click', redo);
  $('#zoom-in').addEventListener('click', () => viewer.setZoom(viewer.zoom * 1.25));
  $('#zoom-out').addEventListener('click', () => viewer.setZoom(viewer.zoom / 1.25));
  $('#zoom-fit').addEventListener('click', () => viewer.resetView());
}

function undo() {
  const it = state.active;
  if (it && it.status === 'done' && it.undo()) { viewer.render(); it.thumb = thumbOf(it); renderQueue(); refreshAll(); }
}
function redo() {
  const it = state.active;
  if (it && it.status === 'done' && it.redo()) { viewer.render(); it.thumb = thumbOf(it); renderQueue(); refreshAll(); }
}

function initInputs() {
  const fi = $('#file-input');
  fi.addEventListener('change', () => { addFiles(fi.files); fi.value = ''; });
  $('#upload-btn').addEventListener('click', (e) => { e.stopPropagation(); fi.click(); });
  $('#add-btn').addEventListener('click', () => fi.click());
  const dz = $('#dropzone');
  dz.addEventListener('click', (e) => { if (!e.target.closest('form')) fi.click(); });
  dz.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === dz) { e.preventDefault(); fi.click(); } });
  $('#url-form').addEventListener('submit', (e) => { e.preventDefault(); addFromUrl($('#url-input').value); });
  $$('.sample').forEach((b) => b.addEventListener('click', async () => {
    const res = await fetch(b.dataset.src);
    const blob = await res.blob();
    addFiles([new File([blob], b.dataset.src.split('/').pop(), { type: blob.type || 'image/jpeg' })]);
  }));
  $('#zip-btn').addEventListener('click', downloadZip);
  $('#quick-dl-btn').addEventListener('click', downloadActive);
  $('#new-btn').addEventListener('click', () => fi.click());
  window.addEventListener('beforeunload', (e) => {
    if (state.items.some((i) => i.status === 'done' && !i.downloaded)) { e.preventDefault(); e.returnValue = ''; }
  });
  $('#about-btn').addEventListener('click', () => $('#about-dialog').showModal());

  // Drag & drop anywhere
  let depth = 0;
  const ov = $('#drop-overlay');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; ov.hidden = false; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) ov.hidden = true; });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0; ov.hidden = true;
    addFiles(e.dataTransfer.files);
  });

  // Paste
  window.addEventListener('paste', (e) => {
    if (e.target.matches && e.target.matches('input, textarea')) return;
    const files = [...(e.clipboardData?.files || [])].filter(isImage);
    if (files.length) { e.preventDefault(); addFiles(files.map((f, i) => f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i}.png`, { type: f.type }))); return; }
    const text = e.clipboardData?.getData('text');
    if (text && /^https?:\/\/\S+$/i.test(text.trim())) { e.preventDefault(); addFromUrl(text); }
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target.matches && e.target.matches('input:not([type=range]):not([type=checkbox]), textarea, select')) return;
    if ($('#workspace').hidden) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 's') { e.preventDefault(); downloadActive(); return; }
    if (mod || e.altKey) return;
    if (e.key === 'Escape') { if (viewer.compare) $('#compare-btn').click(); setTool('pan'); return; }
    const done = state.active && state.active.status === 'done';
    if (k === 'e' && done) setTool('erase');
    else if (k === 'r' && done) setTool('restore');
    else if (k === 'h' || k === 'v') setTool('pan');
    else if (k === '[') { viewer.brushSize = Math.max(4, Math.round(viewer.brushSize / 1.2)); syncPanel(); viewer.render(); }
    else if (k === ']') { viewer.brushSize = Math.min(300, Math.round(viewer.brushSize * 1.2)); syncPanel(); viewer.render(); }
    else if (k === 'c' && done) $('#compare-btn').click();
    else if (k === 'o') { viewer.view = viewer.view === 'original' && done ? 'result' : 'original'; viewer.compare = false; viewer.render(); syncToolbar(); }
    else if (k === '0') viewer.resetView();
    else if (k === '+' || k === '=') viewer.setZoom(viewer.zoom * 1.25);
    else if (k === '-') viewer.setZoom(viewer.zoom / 1.25);
    else if ((k === 'arrowdown' || k === 'arrowright') && state.items.length > 1 && e.target === document.body) {
      const i = state.items.indexOf(state.active); selectItem(state.items[(i + 1) % state.items.length]);
    } else if ((k === 'arrowup' || k === 'arrowleft') && state.items.length > 1 && e.target === document.body) {
      const i = state.items.indexOf(state.active); selectItem(state.items[(i - 1 + state.items.length) % state.items.length]);
    }
  });
}

initModelSelect();
initPanel();
initToolbar();
initInputs();

// Small test/debug hook
window.__obr = { state, viewer, addFiles };
