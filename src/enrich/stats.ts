// Native-resolution statistics. Everything here runs on the decoded artwork *before* any
// upscaling: xBRZ blends edges and invents intermediate colours, which would wreck the counts.

import { bucketize, clusterPalette, hexOf, rgbToLab, type Bucket, type PaletteEntry } from "./color";
import type { RgbaImage } from "./decode";

export type SizeClass = "icon" | "tiny" | "small" | "medium" | "large" | "xlarge" | "huge";

export function sizeClassOf(width: number, height: number): SizeClass {
  const m = Math.max(width, height);
  if (m <= 16) return "icon";
  if (m <= 32) return "tiny";
  if (m <= 64) return "small";
  if (m <= 128) return "medium";
  if (m <= 256) return "large";
  if (m <= 512) return "xlarge";
  return "huge";
}

export const SIZE_CLASSES: SizeClass[] = ["icon", "tiny", "small", "medium", "large", "xlarge", "huge"];

export interface NativeStats {
  width: number;
  height: number;
  pixels: number;
  sizeClass: SizeClass;
  /** exact unique opaque colours (lossless) or ΔE-merged colour groups (lossy) */
  colorCount: number;
  hasTransparency: boolean;
  transparentShare: number;
  /** top entries by coverage among counted (non-background) pixels */
  palette: PaletteEntry[];
  buckets: Bucket[];
  primaryColor: string | null;
  backgroundHex: string | null;
}

const ALPHA_TRANSPARENT = 8; // below this an RGBA pixel is treated as fully transparent
const MAX_PALETTE_FOR_CLUSTERING = 512;
const PALETTE_STORED = 32;

export function computeStats(img: RgbaImage, opts: { lossy?: boolean } = {}): NativeStats {
  const { width, height, data } = img;
  const pixels = width * height;
  const counts = new Map<number, number>();
  const border = new Map<number, number>();
  let transparent = 0;
  let borderOpaque = 0;

  for (let y = 0; y < height; y++) {
    const isBorderRow = y === 0 || y === height - 1;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < ALPHA_TRANSPARENT) {
        transparent++;
        continue;
      }
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (isBorderRow || x === 0 || x === width - 1) {
        border.set(key, (border.get(key) ?? 0) + 1);
        borderOpaque++;
      }
    }
  }

  const opaque = pixels - transparent;
  const transparentShare = pixels ? transparent / pixels : 0;

  // Background: transparent when it covers a meaningful share; otherwise the colour that
  // dominates the border and is also large overall (a flat backdrop, not an outline).
  let backgroundKey: number | null = null;
  if (transparentShare < 0.2 && borderOpaque > 0 && opaque > 0) {
    let bestKey = -1;
    let bestN = 0;
    for (const [k, n] of border) if (n > bestN) (bestN = n), (bestKey = k);
    if (bestKey >= 0 && bestN / borderOpaque >= 0.5 && (counts.get(bestKey) ?? 0) / opaque >= 0.2) backgroundKey = bestKey;
  }
  const backgroundHex = backgroundKey === null ? null : hexOf((backgroundKey >> 16) & 255, (backgroundKey >> 8) & 255, backgroundKey & 255);

  // Palette over counted pixels (opaque minus background), descending by coverage.
  const bgCount = backgroundKey === null ? 0 : counts.get(backgroundKey) ?? 0;
  let counted = opaque - bgCount;
  let entriesSrc = [...counts.entries()].filter(([k]) => k !== backgroundKey);
  if (counted <= 0 || entriesSrc.length === 0) {
    // single-colour image: the background is the only thing there is
    entriesSrc = [...counts.entries()];
    counted = opaque;
    backgroundKey = null;
  }
  entriesSrc.sort((a, b) => b[1] - a[1]);
  const toEntry = ([k, n]: [number, number]): PaletteEntry => {
    const r = (k >> 16) & 255, g = (k >> 8) & 255, b = k & 255;
    const lab = rgbToLab(r, g, b);
    return { hex: hexOf(r, g, b), share: counted ? n / counted : 0, L: lab.L, a: lab.a, b: lab.b };
  };
  const forClustering = entriesSrc.slice(0, MAX_PALETTE_FOR_CLUSTERING).map(toEntry);
  const clusters = clusterPalette(forClustering, 12);
  const buckets = bucketize(clusters);

  const colorCount = opts.lossy ? clusterPalette(forClustering, 4).length + (backgroundKey === null ? 0 : 1) : counts.size;

  return {
    width,
    height,
    pixels,
    sizeClass: sizeClassOf(width, height),
    colorCount,
    hasTransparency: transparent > 0,
    transparentShare,
    palette: forClustering.slice(0, PALETTE_STORED).map((e) => ({ ...e, share: round4(e.share), L: round2(e.L), a: round2(e.a), b: round2(e.b) })),
    buckets: buckets.map((b) => ({ name: b.name, weight: round4(b.weight) })),
    primaryColor: buckets[0]?.name ?? null,
    backgroundHex,
  };
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const round2 = (n: number) => Math.round(n * 100) / 100;
