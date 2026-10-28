// Foreground colour estimation ("edge decontamination").
//
// Implements the blur-fusion estimator from Forte & Pitié, "Approximate Fast
// Foreground Colour Estimation" (ICIP 2021). Semi-transparent edge pixels keep
// a mix of the old background colour; this recovers the true foreground colour
// so hair and soft edges look right on any new background.
//
// The large-radius pass runs on a downscaled copy; the small-radius pass runs
// at full resolution in tiles, only where the matte is partially transparent.

const EPS = 1e-5;

// Separable box blur with clamped edges. src/out/tmp are Float32Array(w*h).
function boxBlur(src, w, h, r, out, tmp) {
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

// rgba: Uint8ClampedArray (w*h*4), modified in place (RGB only).
// alpha: Uint8ClampedArray (w*h).
export function estimateForeground(rgba, alpha, w, h, bigR = 90, smallR = 6) {
  // ---- Pass 1: large radius on a downscaled image ----
  const k = Math.max(1, Math.round(bigR / 12));
  const lw = Math.max(1, Math.ceil(w / k)), lh = Math.max(1, Math.ceil(h / k));
  const ln = lw * lh;
  const la = new Float32Array(ln);
  const lI = [new Float32Array(ln), new Float32Array(ln), new Float32Array(ln)];
  const cnt = new Float32Array(ln);
  for (let y = 0; y < h; y++) {
    const ly = (y / k) | 0;
    for (let x = 0; x < w; x++) {
      const li = ly * lw + ((x / k) | 0);
      const i = y * w + x;
      la[li] += alpha[i] / 255;
      lI[0][li] += rgba[i * 4] / 255;
      lI[1][li] += rgba[i * 4 + 1] / 255;
      lI[2][li] += rgba[i * 4 + 2] / 255;
      cnt[li]++;
    }
  }
  for (let i = 0; i < ln; i++) {
    la[i] /= cnt[i];
    lI[0][i] /= cnt[i]; lI[1][i] /= cnt[i]; lI[2][i] /= cnt[i];
  }
  const lr = Math.max(1, Math.round(bigR / k));
  const tmp = new Float32Array(ln), work = new Float32Array(ln);
  const bA = new Float32Array(ln);
  boxBlur(la, lw, lh, lr, bA, tmp);
  const bF = [], bB = [];
  for (let c = 0; c < 3; c++) {
    const f = new Float32Array(ln), b = new Float32Array(ln);
    for (let i = 0; i < ln; i++) work[i] = lI[c][i] * la[i];
    boxBlur(work, lw, lh, lr, f, tmp);
    for (let i = 0; i < ln; i++) work[i] = lI[c][i] * (1 - la[i]);
    boxBlur(work, lw, lh, lr, b, tmp);
    for (let i = 0; i < ln; i++) {
      f[i] = f[i] / (bA[i] + EPS);
      b[i] = b[i] / (1 - bA[i] + EPS);
    }
    bF.push(f); bB.push(b);
  }

  // Bilinear sample of a low-res plane at full-res pixel (x, y).
  const sample = (plane, x, y) => {
    let fx = (x + 0.5) / k - 0.5, fy = (y + 0.5) / k - 0.5;
    if (fx < 0) fx = 0; if (fy < 0) fy = 0;
    const x0 = Math.min(lw - 1, fx | 0), y0 = Math.min(lh - 1, fy | 0);
    const x1 = Math.min(lw - 1, x0 + 1), y1 = Math.min(lh - 1, y0 + 1);
    const wx = fx - x0, wy = fy - y0;
    const a = plane[y0 * lw + x0], b = plane[y0 * lw + x1];
    const c = plane[y1 * lw + x0], d = plane[y1 * lw + x1];
    return (a + (b - a) * wx) * (1 - wy) + (c + (d - c) * wx) * wy;
  };

  // ---- Pass 2: small radius, full resolution, tiled ----
  const T = 512, m = smallR + 1;
  const maxTW = T + 2 * m, maxN = maxTW * maxTW;
  const ta = new Float32Array(maxN), tba = new Float32Array(maxN);
  const tF = [new Float32Array(maxN), new Float32Array(maxN), new Float32Array(maxN)];
  const tB = [new Float32Array(maxN), new Float32Array(maxN), new Float32Array(maxN)];
  const tw1 = new Float32Array(maxN), tw2 = new Float32Array(maxN), tt = new Float32Array(maxN);
  const tbF = [new Float32Array(maxN), new Float32Array(maxN), new Float32Array(maxN)];

  for (let ty = 0; ty < h; ty += T) {
    for (let tx = 0; tx < w; tx += T) {
      const iw = Math.min(T, w - tx), ih = Math.min(T, h - ty);
      // Skip tiles with no partially transparent pixels.
      let uncertain = false;
      for (let y = ty; y < ty + ih && !uncertain; y++) {
        for (let x = tx; x < tx + iw; x++) {
          const a = alpha[y * w + x];
          if (a > 2 && a < 253) { uncertain = true; break; }
        }
      }
      if (!uncertain) continue;

      const x0 = Math.max(0, tx - m), y0 = Math.max(0, ty - m);
      const x1 = Math.min(w, tx + iw + m), y1 = Math.min(h, ty + ih + m);
      const bw = x1 - x0, bh = y1 - y0, bn = bw * bh;
      // F1 from pass 1, B1 = blurred background
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const gx = x0 + x, gy = y0 + y, gi = gy * w + gx, i = y * bw + x;
          const a = alpha[gi] / 255;
          ta[i] = a;
          for (let c = 0; c < 3; c++) {
            const I = rgba[gi * 4 + c] / 255;
            const f = sample(bF[c], gx, gy), b = sample(bB[c], gx, gy);
            let F1 = f + a * (I - a * f - (1 - a) * b);
            F1 = F1 < 0 ? 0 : F1 > 1 ? 1 : F1;
            tF[c][i] = F1;
            tB[c][i] = b;
          }
        }
      }
      const tA = ta.subarray(0, bn), tBA = tba.subarray(0, bn);
      const w1 = tw1.subarray(0, bn), w2 = tw2.subarray(0, bn), t3 = tt.subarray(0, bn);
      boxBlur(tA, bw, bh, smallR, tBA, t3);
      for (let c = 0; c < 3; c++) {
        for (let i = 0; i < bn; i++) w1[i] = tF[c][i] * ta[i];
        boxBlur(w1, bw, bh, smallR, tbF[c].subarray(0, bn), t3);
        for (let i = 0; i < bn; i++) w1[i] = tB[c][i] * (1 - ta[i]);
        boxBlur(w1, bw, bh, smallR, w2, t3);
        // reuse tB[c] to hold blurred background
        for (let i = 0; i < bn; i++) {
          tbF[c][i] = tbF[c][i] / (tBA[i] + EPS);
          tB[c][i] = w2[i] / (1 - tBA[i] + EPS);
        }
      }
      for (let y = ty; y < ty + ih; y++) {
        for (let x = tx; x < tx + iw; x++) {
          const gi = y * w + x;
          const a8 = alpha[gi];
          if (a8 <= 2 || a8 >= 253) continue;
          const a = a8 / 255;
          const i = (y - y0) * bw + (x - x0);
          for (let c = 0; c < 3; c++) {
            const I = rgba[gi * 4 + c] / 255;
            const f = tbF[c][i], b = tB[c][i];
            let F = f + a * (I - a * f - (1 - a) * b);
            F = F < 0 ? 0 : F > 1 ? 1 : F;
            rgba[gi * 4 + c] = F * 255;
          }
        }
      }
    }
  }
}
