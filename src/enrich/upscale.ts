// Upscaling for the image the AI models see (and for R2 previews).
// xBRZ ("scale by rules") keeps pixel-art edges crisp while smoothing curves — the right input
// for a vision model that would otherwise see a blurry bilinear resize of a small sprite.
// Nearest-neighbour is the fallback (and always used when the factor is 1).

import { xbrzColorFormat, xbrzConfig, xbrzScale } from "xbrz-js";
import type { RgbaImage } from "./decode";

export type Scaler = "xbrz" | "nearest";

export const XBRZ_MAX_FACTOR = 6;

/** Integer factor that brings the long side to at least `target` px, capped at xBRZ's maximum. */
export function factorFor(width: number, height: number, target: number): number {
  const m = Math.max(width, height, 1);
  return Math.max(1, Math.min(XBRZ_MAX_FACTOR, Math.ceil(target / m)));
}

export function upscaleNearest(img: RgbaImage, factor: number): RgbaImage {
  if (factor <= 1) return img;
  const { width, height, data } = img;
  const W = width * factor;
  const H = height * factor;
  const out = new Uint8Array(W * H * 4);
  const src32 = new Uint32Array(data.buffer, data.byteOffset, width * height);
  const dst32 = new Uint32Array(out.buffer);
  for (let y = 0; y < H; y++) {
    const sy = (y / factor) | 0;
    const rowOff = sy * width;
    const dOff = y * W;
    for (let x = 0; x < W; x++) dst32[dOff + x] = src32[rowOff + ((x / factor) | 0)];
  }
  return { width: W, height: H, data: out };
}

const XBRZ_CFG = xbrzConfig({ equalColorTolerance: 30, oobRead: "transparent" });

export function upscaleXbrz(img: RgbaImage, factor: number): RgbaImage {
  if (factor <= 1) return img;
  if (factor > XBRZ_MAX_FACTOR) throw new Error(`xBRZ factor ${factor} > ${XBRZ_MAX_FACTOR}`);
  const { width, height, data } = img;
  // xbrz-js reads 32-bit pixels with alpha in the high byte; RGBA bytes on a little-endian
  // machine give exactly that layout (0xAABBGGRR).
  const srcBuf = data.byteOffset % 4 === 0 ? data : data.slice();
  const src = new Uint32Array(srcBuf.buffer, srcBuf.byteOffset, width * height);
  const dst = new Uint32Array(width * factor * height * factor);
  xbrzScale(factor, src, dst, width, height, xbrzColorFormat.argb, XBRZ_CFG);
  return { width: width * factor, height: height * factor, data: new Uint8Array(dst.buffer) };
}

export function upscale(img: RgbaImage, factor: number, scaler: Scaler): RgbaImage {
  if (factor <= 1) return img;
  return scaler === "xbrz" ? upscaleXbrz(img, factor) : upscaleNearest(img, factor);
}
