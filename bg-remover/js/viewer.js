// Interactive canvas view: fit/zoom/pan, before/after compare, brush input.
import { composite } from './editor.js';

function checkerPattern(ctx, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size * 2;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, size * 2, size * 2);
  x.fillStyle = '#e3e5e8';
  x.fillRect(0, 0, size, size);
  x.fillRect(size, size, size, size);
  return ctx.createPattern(c, 'repeat');
}

export class Viewer {
  constructor(canvas, { onChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.item = null;
    this.view = 'result'; // 'result' | 'original'
    this.compare = false;
    this.split = 0.5;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.tool = 'pan'; // 'pan' | 'erase' | 'restore'
    this.brushSize = 40; // screen px (diameter)
    this.hardness = 0.6;
    this.onChange = onChange || (() => {});
    this._pointers = new Map();
    this._cursor = null;
    this._raf = 0;
    this._pattern = null;
    this._dpr = 1;
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._resize();
    this._bind();
  }

  setItem(item) {
    if (this.item !== item) {
      this.item = item;
      this.zoom = 1; this.panX = 0; this.panY = 0;
    }
    this.render();
  }

  _resize() {
    const p = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    this._dpr = dpr;
    const w = Math.max(1, p.clientWidth), h = Math.max(1, p.clientHeight);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this._pattern = checkerPattern(this.ctx, Math.round(10 * dpr));
    this.render();
  }

  // Transform from image coords to canvas device px.
  _transform() {
    const item = this.item;
    const rect = this.view === 'original' || !item.cutout
      ? { x: 0, y: 0, w: item.width, h: item.height }
      : item.outputRect();
    const cw = this.canvas.width, ch = this.canvas.height;
    const margin = 24 * this._dpr;
    const fit = Math.min((cw - 2 * margin) / rect.w, (ch - 2 * margin) / rect.h);
    const s = fit * this.zoom;
    const ox = cw / 2 - (rect.x + rect.w / 2) * s + this.panX * this._dpr;
    const oy = ch / 2 - (rect.y + rect.h / 2) * s + this.panY * this._dpr;
    return { s, ox, oy, rect, fit };
  }

  toImage(clientX, clientY) {
    const b = this.canvas.getBoundingClientRect();
    const { s, ox, oy } = this._transform();
    const px = (clientX - b.left) * this._dpr, py = (clientY - b.top) * this._dpr;
    return { x: (px - ox) / s, y: (py - oy) / s };
  }

  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  _draw() {
    const { ctx, canvas, item } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!item || !item.original) return;
    const { s, ox, oy, rect } = this._transform();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = s < 1 ? 'high' : 'low';
    const showResult = this.view === 'result' && item.cutout;

    if (showResult) {
      // checkerboard behind transparent output
      ctx.save();
      ctx.fillStyle = this._pattern;
      const rx = rect.x * s + ox, ry = rect.y * s + oy;
      ctx.translate(rx, ry);
      ctx.fillRect(0, 0, rect.w * s, rect.h * s);
      ctx.restore();
      ctx.setTransform(s, 0, 0, s, ox, oy);
      composite(ctx, item, s);
      if (this.compare) {
        const sx = this.split * canvas.width;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, sx, canvas.height);
        ctx.clip();
        ctx.setTransform(s, 0, 0, s, ox, oy);
        ctx.drawImage(item.original, 0, 0, item.width, item.height);
        ctx.restore();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#fff';
        ctx.fillRect(sx - 1 * this._dpr, 0, 2 * this._dpr, canvas.height);
        ctx.beginPath();
        ctx.arc(sx, canvas.height / 2, 16 * this._dpr, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.shadowColor = 'rgba(0,0,0,.35)';
        ctx.shadowBlur = 6 * this._dpr;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#334';
        ctx.font = `${12 * this._dpr}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⟷', sx, canvas.height / 2);
      }
    } else {
      ctx.setTransform(s, 0, 0, s, ox, oy);
      ctx.drawImage(item.original, 0, 0, item.width, item.height);
    }

    // brush cursor
    if (this._cursor && showResult && (this.tool === 'erase' || this.tool === 'restore')) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const r = (this.brushSize / 2) * this._dpr;
      ctx.beginPath();
      ctx.arc(this._cursor.x, this._cursor.y, r, 0, Math.PI * 2);
      ctx.lineWidth = 2 * this._dpr;
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      ctx.stroke();
      ctx.lineWidth = 1 * this._dpr;
      ctx.strokeStyle = this.tool === 'erase' ? '#ff5a6e' : '#3ddc97';
      ctx.stroke();
      if (this.hardness < 0.95) {
        ctx.beginPath();
        ctx.arc(this._cursor.x, this._cursor.y, r * this.hardness, 0, Math.PI * 2);
        ctx.setLineDash([3 * this._dpr, 3 * this._dpr]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  setZoom(z, cx, cy) {
    const old = this.zoom;
    z = Math.min(32, Math.max(0.1, z));
    if (cx !== undefined) {
      // keep the point under the cursor fixed
      const b = this.canvas.getBoundingClientRect();
      const px = cx - b.left - b.width / 2, py = cy - b.top - b.height / 2;
      this.panX = px - (px - this.panX) * (z / old);
      this.panY = py - (py - this.panY) * (z / old);
    } else {
      this.panX *= z / old; this.panY *= z / old;
    }
    this.zoom = z;
    this.render();
    this.onChange('zoom');
  }

  resetView() {
    this.zoom = 1; this.panX = 0; this.panY = 0;
    this.render();
    this.onChange('zoom');
  }

  _brushActive() {
    return this.item && this.item.cutout && this.view === 'result' && (this.tool === 'erase' || this.tool === 'restore');
  }

  _strokeTo(clientX, clientY) {
    const item = this.item;
    const p = this.toImage(clientX, clientY);
    const { s } = this._transform();
    const r = (this.brushSize / 2) * this._dpr / s;
    const last = this._last || p;
    const dx = p.x - last.x, dy = p.y - last.y;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(0.5, r / 4);
    const n = Math.max(1, Math.ceil(dist / step));
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = this._last ? 1 : 0; i <= n; i++) {
      const t = i / n;
      const box = item.dab(last.x + dx * t, last.y + dy * t, r, this.hardness, this.tool);
      if (box) {
        bx0 = Math.min(bx0, box.x); by0 = Math.min(by0, box.y);
        bx1 = Math.max(bx1, box.x + box.w); by1 = Math.max(by1, box.y + box.h);
      }
    }
    if (bx1 > bx0) item.flush(bx0, by0, bx1 - bx0, by1 - by0);
    this._last = p;
    this.render();
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.item || !this.item.original) return;
      c.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size === 2) {
        // pinch start: cancel any stroke
        if (this._mode === 'brush') this._finishStroke();
        const [a, b] = [...this._pointers.values()];
        this._pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, panX: this.panX, panY: this.panY };
        this._mode = 'pinch';
        return;
      }
      if (this.compare && this.view === 'result' && this.item.cutout) {
        const b = c.getBoundingClientRect();
        const sx = this.split * b.width;
        if (Math.abs(e.clientX - b.left - sx) < 24) { this._mode = 'split'; return; }
      }
      const spaceHeld = this._space;
      if (this._brushActive() && !spaceHeld && e.button === 0) {
        this._mode = 'brush';
        this.item.beginStroke();
        this._last = null;
        this._strokeTo(e.clientX, e.clientY);
      } else {
        this._mode = 'pan';
        this._panStart = { x: e.clientX, y: e.clientY, panX: this.panX, panY: this.panY };
      }
    });
    c.addEventListener('pointermove', (e) => {
      const b = c.getBoundingClientRect();
      this._cursor = { x: (e.clientX - b.left) * this._dpr, y: (e.clientY - b.top) * this._dpr };
      if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._mode === 'pinch' && this._pointers.size >= 2) {
        const [p1, p2] = [...this._pointers.values()];
        const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        const z = Math.min(32, Math.max(0.1, this._pinch.zoom * d / this._pinch.d));
        const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
        this.zoom = z;
        this.panX = this._pinch.panX * (z / this._pinch.zoom) + (mx - this._pinch.mx);
        this.panY = this._pinch.panY * (z / this._pinch.zoom) + (my - this._pinch.my);
        this.onChange('zoom');
      } else if (this._mode === 'brush') {
        this._strokeTo(e.clientX, e.clientY);
        return;
      } else if (this._mode === 'pan') {
        this.panX = this._panStart.panX + (e.clientX - this._panStart.x);
        this.panY = this._panStart.panY + (e.clientY - this._panStart.y);
      } else if (this._mode === 'split') {
        this.split = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width));
      }
      this.render();
    });
    const end = (e) => {
      this._pointers.delete(e.pointerId);
      if (this._mode === 'brush') this._finishStroke();
      if (this._pointers.size === 0) this._mode = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { this._cursor = null; this.render(); });
    c.addEventListener('wheel', (e) => {
      if (!this.item) return;
      e.preventDefault();
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      this.setZoom(this.zoom * f, e.clientX, e.clientY);
    }, { passive: false });
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target === document.body) { this._space = true; e.preventDefault(); } });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this._space = false; });
  }

  _finishStroke() {
    this._mode = null;
    this._last = null;
    if (this.item.endStroke()) this.onChange('edit');
  }
}
