// Fast guided-filter upsampling of the model mask.
// He & Sun, "Fast Guided Filter" (2015), colour guide. The linear coefficients are
// solved at mask resolution against the image resized exactly like the model input,
// then bilinearly upsampled (same half-pixel mapping as upscaleMask) and applied to
// the full-resolution image, so edges snap to real image edges instead of the
// 1024-px staircase/blur of plain bilinear upscaling.

// Separable box mean, clamped borders (same as matting.js boxBlur).
function boxMean(src, w, h, r, out, tmp) {
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / d;
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / d;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
}

// mask: Uint8ClampedArray(ms*ms) model output; guideLo: RGBA Uint8ClampedArray(ms*ms*4),
// the image resized to ms x ms (the `px` already computed in preprocess());
// rgba: full-res RGBA (w*h*4). Returns Uint8ClampedArray(w*h) alpha.
// lo/hi: optional contrast curve that snaps near-0/near-1 values (0 and 1 disable it).
export function guidedUpscale(mask, ms, guideLo, rgba, w, h, r = 2, eps = 1e-4, lo = 0.04, hi = 0.96) {
  const n = ms * ms;
  const F = () => new Float32Array(n);
  const I0 = F(), I1 = F(), I2 = F(), p = F();
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    I0[i] = guideLo[j] / 255; I1[i] = guideLo[j + 1] / 255; I2[i] = guideLo[j + 2] / 255; p[i] = mask[i] / 255;
  }
  const tmp = F(), work = F();
  const blur = (src, out) => { boxMean(src, ms, ms, r, out, tmp); return out; };
  const prod = (a, b, out) => { for (let i = 0; i < n; i++) work[i] = a[i] * b[i]; return blur(work, out); };
  const m0 = blur(I0, F()), m1 = blur(I1, F()), m2 = blur(I2, F()), mp = blur(p, F());
  // covariances (in place: become a0,a1,a2,b after solving)
  const c0 = prod(I0, p, F()), c1 = prod(I1, p, F()), c2 = prod(I2, p, F());
  const v00 = prod(I0, I0, F()), v01 = prod(I0, I1, F()), v02 = prod(I0, I2, F());
  const v11 = prod(I1, I1, F()), v12 = prod(I1, I2, F()), v22 = prod(I2, I2, F());
  for (let i = 0; i < n; i++) {
    const a = m0[i], b = m1[i], c = m2[i], q = mp[i];
    const s00 = v00[i] - a * a + eps, s01 = v01[i] - a * b, s02 = v02[i] - a * c;
    const s11 = v11[i] - b * b + eps, s12 = v12[i] - b * c, s22 = v22[i] - c * c + eps;
    const y0 = c0[i] - a * q, y1 = c1[i] - b * q, y2 = c2[i] - c * q;
    // inverse of symmetric 3x3 via cofactors
    const k00 = s11 * s22 - s12 * s12, k01 = s02 * s12 - s01 * s22, k02 = s01 * s12 - s02 * s11;
    const k11 = s00 * s22 - s02 * s02, k12 = s01 * s02 - s00 * s12, k22 = s00 * s11 - s01 * s01;
    const det = s00 * k00 + s01 * k01 + s02 * k02;
    const id = det > 1e-30 ? 1 / det : 0;
    const A0 = (k00 * y0 + k01 * y1 + k02 * y2) * id;
    const A1 = (k01 * y0 + k11 * y1 + k12 * y2) * id;
    const A2 = (k02 * y0 + k12 * y1 + k22 * y2) * id;
    c0[i] = A0; c1[i] = A1; c2[i] = A2;
    v00[i] = q - A0 * a - A1 * b - A2 * c; // b coefficient
  }
  const A0 = blur(c0, m0), A1 = blur(c1, m1), A2 = blur(c2, m2), B = blur(v00, mp);
  // Full resolution: q = A·I + B with bilinear-upsampled coefficients.
  const out = new Uint8ClampedArray(w * h);
  const sx = ms / w, sy = ms / h;
  const xi0 = new Int32Array(w), xi1 = new Int32Array(w), xw = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let fx = (x + 0.5) * sx - 0.5; if (fx < 0) fx = 0;
    const x0 = Math.min(ms - 1, fx | 0);
    xi0[x] = x0; xi1[x] = Math.min(ms - 1, x0 + 1); xw[x] = fx - x0;
  }
  const curve = hi > lo && (lo > 0 || hi < 1);
  const sc = 1 / (hi - lo);
  const planes = [A0, A1, A2, B];
  const coef = new Float32Array(4);
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) * sy - 0.5; if (fy < 0) fy = 0;
    const y0 = Math.min(ms - 1, fy | 0), y1 = Math.min(ms - 1, y0 + 1), wy = fy - y0;
    const r0 = y0 * ms, r1 = y1 * ms;
    for (let x = 0; x < w; x++) {
      const a0 = xi0[x], a1 = xi1[x], wx = xw[x];
      for (let k = 0; k < 4; k++) {
        const P = planes[k];
        const t = P[r0 + a0] + (P[r0 + a1] - P[r0 + a0]) * wx;
        const b = P[r1 + a0] + (P[r1 + a1] - P[r1 + a0]) * wx;
        coef[k] = t + (b - t) * wy;
      }
      const j = (y * w + x) * 4;
      let v = (coef[0] * rgba[j] + coef[1] * rgba[j + 1] + coef[2] * rgba[j + 2]) / 255 + coef[3];
      if (curve) v = (v - lo) * sc;
      out[y * w + x] = v * 255; // Uint8ClampedArray clamps + rounds
    }
  }
  return out;
}
