// 64-bit perceptual hash (DCT-based, "pHash") for near-duplicate detection.
// Computed on the native image composited over white; robust to rescaling and re-encoding.

import type { RgbaImage } from "./decode";

const N = 32; // DCT size
const K = 8; // low-frequency block

/** Grayscale N×N via box filter (area average), transparent pixels composited over white. */
function downscaleGray(img: RgbaImage, n: number): Float64Array {
  const out = new Float64Array(n * n);
  const { width, height, data } = img;
  for (let oy = 0; oy < n; oy++) {
    const y0 = Math.floor((oy * height) / n);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * height) / n));
    for (let ox = 0; ox < n; ox++) {
      const x0 = Math.floor((ox * width) / n);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * width) / n));
      let sum = 0;
      let cnt = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          const i = (y * width + x) * 4;
          const a = data[i + 3] / 255;
          const r = data[i] * a + 255 * (1 - a);
          const g = data[i + 1] * a + 255 * (1 - a);
          const b = data[i + 2] * a + 255 * (1 - a);
          sum += 0.299 * r + 0.587 * g + 0.114 * b;
          cnt++;
        }
      }
      out[oy * n + ox] = cnt ? sum / cnt : 255;
    }
  }
  return out;
}

const COS = (() => {
  const t = new Float64Array(N * N);
  for (let u = 0; u < N; u++) for (let x = 0; x < N; x++) t[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  return t;
})();

/** Top-left K×K block of the 2D DCT-II (separable). */
function dctLow(px: Float64Array): Float64Array {
  const rows = new Float64Array(N * K); // rows[y*K + u]
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < K; u++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += px[y * N + x] * COS[u * N + x];
      rows[y * K + u] = s;
    }
  }
  const out = new Float64Array(K * K); // out[v*K + u]
  for (let v = 0; v < K; v++) {
    for (let u = 0; u < K; u++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += rows[y * K + u] * COS[v * N + y];
      out[v * K + u] = s;
    }
  }
  return out;
}

/** 16 hex chars. */
export function phash(img: RgbaImage): string {
  const px = downscaleGray(img, N);
  const dct = dctLow(px);
  const ac = Array.from(dct.subarray(1)).sort((a, b) => a - b);
  const median = ac.length % 2 ? ac[(ac.length - 1) / 2] : (ac[ac.length / 2 - 1] + ac[ac.length / 2]) / 2;
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < 64; i++) {
    const bit = dct[i] > median ? 1 : 0;
    if (i < 32) hi = (hi << 1) | bit;
    else lo = (lo << 1) | bit;
  }
  return (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0");
}

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < 16; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
    while (x) {
      x &= x - 1;
      d++;
    }
  }
  return d;
}

/** Eight 8-bit chunks (index 0 = most significant byte). Two hashes within distance 7 share ≥ 1 chunk. */
export function phashChunks(hash: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < 16; i += 2) out.push(parseInt(hash.slice(i, i + 2), 16));
  return out;
}
