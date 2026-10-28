// Image item state, compositing, brush editing, undo/redo and export.

export const MAX_PIXELS = 16_000_000; // iOS Safari canvas limit is ~16.7 MP
const TILE = 128;

let nextId = 1;

export function defaultSettings() {
  return {
    bg: { type: 'transparent', color: '#ffffff', image: null, imageName: '', blur: 30 },
    shadow: { enabled: false, opacity: 0.45, blur: 3, x: 0, y: 2 },
    crop: { enabled: false, padding: 5, aspect: 'original' },
  };
}

export function createCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export class Item {
  constructor(file, name) {
    this.id = nextId++;
    this.file = file;
    this.name = name || file.name || `image-${this.id}`;
    this.status = 'queued';
    this.error = '';
    this.width = 0;
    this.height = 0;
    this.original = null; // ImageBitmap or canvas
    this.cutout = null; // ImageData RGBA (A = matte)
    this._cutoutCanvas = null;
    this.origData = null;
    this.thumb = '';
    this.undoStack = [];
    this.redoStack = [];
    this.settings = defaultSettings();
    this._blurCache = null;
    this._bboxCache = null;
    this.downscaled = false;
    this.backend = '';
    this.timings = null;
  }

  setCutout(rgbaBuffer, w, h) {
    this.cutout = new ImageData(new Uint8ClampedArray(rgbaBuffer), w, h);
    this._cutoutCanvas = null;
    this._bboxCache = null;
  }

  // Canvas copy of the cutout for drawing; rebuilt on demand.
  get cutoutCanvas() {
    if (!this._cutoutCanvas && this.cutout) {
      this._cutoutCanvas = createCanvas(this.width, this.height);
      this._cutoutCanvas.getContext('2d').putImageData(this.cutout, 0, 0);
    }
    return this._cutoutCanvas;
  }

  set cutoutCanvas(v) { this._cutoutCanvas = v; }

  // Free derived buffers while the item is not being viewed.
  releaseCaches() {
    this._cutoutCanvas = null;
    this.origData = null;
    this._blurCache = null;
  }

  getOrigData() {
    if (!this.origData) {
      const c = createCanvas(this.width, this.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(this.original, 0, 0);
      this.origData = ctx.getImageData(0, 0, this.width, this.height);
    }
    return this.origData;
  }

  flush(x, y, w, h) {
    x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
    w = Math.min(this.width - x, Math.ceil(w)); h = Math.min(this.height - y, Math.ceil(h));
    if (w <= 0 || h <= 0) return;
    if (this._cutoutCanvas) this._cutoutCanvas.getContext('2d').putImageData(this.cutout, 0, 0, x, y, w, h);
    // Keep the crop box (and so the view) fixed while a stroke is in progress.
    if (!this._stroke) this._bboxCache = null;
  }

  // Bounding box of visible subject pixels.
  subjectBBox() {
    if (this._bboxCache) return this._bboxCache;
    const { width: w, height: h } = this;
    const d = this.cutout.data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      let row = y * w * 4 + 3;
      for (let x = 0; x < w; x++, row += 4) {
        if (d[row] > 16) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    this._bboxCache = x1 < 0 ? { x: 0, y: 0, w, h } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    return this._bboxCache;
  }

  // Output rectangle in image coordinates (crop may extend past the image).
  outputRect() {
    const r = this._baseRect();
    const asp = this.settings.crop.aspect;
    if (!asp || asp === 'original') return r;
    // Grow the short side so the canvas has the requested aspect ratio.
    const [aw, ah] = asp.split(':').map(Number);
    const target = aw / ah;
    if (r.w / r.h < target) {
      const w = Math.round(r.h * target);
      return { x: r.x - Math.round((w - r.w) / 2), y: r.y, w, h: r.h };
    }
    const h = Math.round(r.w / target);
    // Keep subjects cut off at the bottom anchored there (portraits).
    const b = this.settings.crop.enabled ? this.subjectBBox() : null;
    const anchorBottom = b && b.y + b.h >= this.height - 1;
    return { x: r.x, y: anchorBottom ? r.y + r.h - h : r.y - Math.round((h - r.h) / 2), w: r.w, h };
  }

  _baseRect() {
    if (!this.settings.crop.enabled) return { x: 0, y: 0, w: this.width, h: this.height };
    const b = this.subjectBBox();
    const pad = Math.round(Math.max(b.w, b.h) * this.settings.crop.padding / 100);
    // No margin on sides where the subject is cut off by the photo's edge.
    const l = b.x <= 1 ? 0 : pad, t = b.y <= 1 ? 0 : pad;
    const r = b.x + b.w >= this.width - 1 ? 0 : pad, btm = b.y + b.h >= this.height - 1 ? 0 : pad;
    return { x: b.x - l, y: b.y - t, w: b.w + l + r, h: b.h + t + btm };
  }

  blurredBackground() {
    const amt = this.settings.bg.blur;
    if (this._blurCache && this._blurCache.amt === amt) return this._blurCache.canvas;
    const { width: w, height: h } = this;
    // Blur radius relative to image size.
    const radius = Math.max(1, (Math.max(w, h) * amt) / 1000);
    const f = Math.max(1, radius / 3);
    const sw = Math.max(4, Math.round(w / f)), sh = Math.max(4, Math.round(h / f));
    const small = createCanvas(sw, sh);
    const sctx = small.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(this.original, 0, 0, sw, sh);
    const out = createCanvas(sw, sh);
    const octx = out.getContext('2d');
    // ctx.filter where supported, plus a downscale for the rest.
    // Opaque base layer so the blurred edges never turn semi-transparent.
    octx.drawImage(small, 0, 0, sw, sh);
    octx.filter = `blur(${Math.max(1, radius / f)}px)`;
    // Draw slightly oversized to avoid transparent edges from the blur.
    const m = radius / f * 3.5;
    octx.drawImage(small, -m, -m, sw + 2 * m, sh + 2 * m);
    octx.filter = 'none';
    this._blurCache = { amt, canvas: out };
    return out;
  }

  // ---------- Brush editing ----------

  beginStroke() {
    this._stroke = { tiles: new Map() };
  }

  _snapshotTile(tx, ty) {
    const key = ty * 100000 + tx;
    const s = this._stroke;
    let t = s.tiles.get(key);
    if (!t) {
      const x = tx * TILE, y = ty * TILE;
      const w = Math.min(TILE, this.width - x), h = Math.min(TILE, this.height - y);
      const buf = new Uint8ClampedArray(w * h * 4);
      const d = this.cutout.data;
      for (let r = 0; r < h; r++) {
        const src = ((y + r) * this.width + x) * 4;
        buf.set(d.subarray(src, src + w * 4), r * w * 4);
      }
      t = { x, y, w, h, data: buf };
      s.tiles.set(key, t);
    }
    return t;
  }

  // Apply one circular dab. mode: 'erase' | 'restore'.
  dab(cx, cy, radius, hardness, mode) {
    const r = Math.max(0.5, radius);
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(this.width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(this.height - 1, Math.ceil(cy + r));
    if (x0 > x1 || y0 > y1) return null;
    for (let ty = (y0 / TILE) | 0; ty <= ((y1 / TILE) | 0); ty++)
      for (let tx = (x0 / TILE) | 0; tx <= ((x1 / TILE) | 0); tx++) this._snapshotTile(tx, ty);
    const d = this.cutout.data;
    const orig = mode === 'restore' ? this.getOrigData().data : null;
    const tiles = this._stroke.tiles;
    const hard = Math.min(0.99, Math.max(0, hardness));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      const ty = (y / TILE) | 0;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dist = Math.sqrt(dx * dx + dy * dy) / r;
        if (dist > 1) continue;
        let wgt = dist <= hard ? 1 : 1 - (dist - hard) / (1 - hard);
        wgt = wgt * wgt * (3 - 2 * wgt);
        const t = tiles.get(ty * 100000 + ((x / TILE) | 0));
        const pi = ((y - t.y) * t.w + (x - t.x)) * 4;
        const pristine = t.data[pi + 3];
        const i = (y * this.width + x) * 4;
        if (mode === 'erase') {
          const na = pristine * (1 - wgt);
          if (na < d[i + 3]) d[i + 3] = na;
        } else {
          // never exceed the input image's own alpha
          const na = pristine + (orig[i + 3] - pristine) * wgt;
          if (na > d[i + 3]) {
            d[i + 3] = na;
            d[i] = orig[i]; d[i + 1] = orig[i + 1]; d[i + 2] = orig[i + 2];
          }
        }
      }
    }
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  endStroke() {
    const s = this._stroke;
    this._stroke = null;
    this._bboxCache = null;
    if (!s || s.tiles.size === 0) return false;
    this.undoStack.push([...s.tiles.values()]);
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack = [];
    return true;
  }

  _swapTiles(tiles) {
    const d = this.cutout.data;
    const out = [];
    for (const t of tiles) {
      const cur = new Uint8ClampedArray(t.w * t.h * 4);
      for (let r = 0; r < t.h; r++) {
        const src = ((t.y + r) * this.width + t.x) * 4;
        cur.set(d.subarray(src, src + t.w * 4), r * t.w * 4);
        d.set(t.data.subarray(r * t.w * 4, (r + 1) * t.w * 4), src);
      }
      out.push({ ...t, data: cur });
      this.flush(t.x, t.y, t.w, t.h);
    }
    return out;
  }

  undo() {
    const t = this.undoStack.pop();
    if (!t) return false;
    this.redoStack.push(this._swapTiles(t));
    return true;
  }

  redo() {
    const t = this.redoStack.pop();
    if (!t) return false;
    this.undoStack.push(this._swapTiles(t));
    return true;
  }
}

// ---------- Compositing ----------

function drawCover(ctx, img, x, y, w, h) {
  const iw = img.width, ih = img.height;
  const s = Math.max(w / iw, h / ih);
  const dw = iw * s, dh = ih * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

// Draws the final composition. The caller sets ctx's transform so that one
// unit equals one image pixel; deviceScale is the resulting pixels-per-unit
// (needed because canvas shadows ignore the transform).
export function composite(ctx, item, deviceScale, { transparentFill = null } = {}) {
  const s = item.settings;
  const rect = item.outputRect();
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  if (s.bg.type === 'color') {
    // "#aaaaaa>#bbbbbb" means a diagonal two-stop gradient
    const stops = s.bg.color.split('>');
    if (stops.length === 2) {
      const g = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
      g.addColorStop(0, stops[0]);
      g.addColorStop(1, stops[1]);
      ctx.fillStyle = g;
    } else ctx.fillStyle = s.bg.color;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  } else if (s.bg.type === 'image' && s.bg.image) {
    drawCover(ctx, s.bg.image, rect.x, rect.y, rect.w, rect.h);
  } else if (s.bg.type === 'blur') {
    const b = item.blurredBackground();
    // Cover the output rect too, in case crop padding extends past the image.
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > item.width || rect.y + rect.h > item.height) {
      drawCover(ctx, b, rect.x, rect.y, rect.w, rect.h);
    }
    ctx.drawImage(b, 0, 0, item.width, item.height);
  } else if (transparentFill) {
    ctx.fillStyle = transparentFill;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  if (s.shadow.enabled) {
    const ref = Math.max(item.width, item.height) / 100;
    ctx.shadowColor = `rgba(0,0,0,${s.shadow.opacity})`;
    ctx.shadowBlur = s.shadow.blur * ref * deviceScale;
    ctx.shadowOffsetX = s.shadow.x * ref * deviceScale;
    ctx.shadowOffsetY = s.shadow.y * ref * deviceScale;
  }
  ctx.drawImage(item.cutoutCanvas, 0, 0);
  ctx.restore();
}

export const FORMATS = {
  png: { mime: 'image/png', ext: 'png', label: 'PNG' },
  jpg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPG' },
  webp: { mime: 'image/webp', ext: 'webp', label: 'WebP' },
};

export function exportSize(item, size) {
  const rect = item.outputRect();
  let scale = 1;
  if (size !== 'full') {
    const max = Number(size);
    scale = Math.min(1, max / Math.max(rect.w, rect.h));
  }
  // Keep within canvas limits.
  const px = rect.w * rect.h * scale * scale;
  if (px > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / px);
  return { w: Math.max(1, Math.round(rect.w * scale)), h: Math.max(1, Math.round(rect.h * scale)), scale, rect };
}

export async function exportBlob(item, { format = 'png', size = 'full', quality = 0.92 } = {}) {
  const f = FORMATS[format];
  const { w, h, scale, rect } = exportSize(item, size);
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(w / rect.w, 0, 0, h / rect.h, -rect.x * (w / rect.w), -rect.y * (h / rect.h));
  composite(ctx, item, scale, { transparentFill: format === 'jpg' ? '#ffffff' : null });
  const blob = await new Promise((res) => c.toBlob(res, f.mime, quality));
  if (!blob) throw new Error('Export failed (canvas too large?)');
  return blob;
}

// Strip path separators and reserved characters so names can't escape a folder.
export function safeName(name) {
  return String(name).replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').replace(/^[.\s]+/, '') || 'image';
}

export function outputName(item, format) {
  const base = safeName(item.name.replace(/\.[^.]+$/, ''));
  return `${base}-no-bg.${FORMATS[format].ext}`;
}
