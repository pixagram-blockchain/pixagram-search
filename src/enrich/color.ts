// Colour maths: sRGB -> CIELAB, CIEDE2000, a fixed vocabulary of named colours, and the
// palette -> buckets reduction used for the "primary colour" filter.

export interface Lab {
  L: number;
  a: number;
  b: number;
}

export function hexOf(r: number, g: number, b: number): string {
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

export function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function linearize(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** sRGB (D65) -> CIELAB. */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const rl = linearize(r);
  const gl = linearize(g);
  const bl = linearize(b);
  // sRGB -> XYZ (D65)
  let x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  let y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175;
  let z = (rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x);
  y = f(y);
  z = f(z);
  return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

const deg = Math.PI / 180;

/** CIEDE2000 colour difference. */
export function deltaE2000(c1: Lab, c2: Lab): number {
  const L1 = c1.L, a1 = c1.a, b1 = c1.b;
  const L2 = c2.L, a2 = c2.a, b2 = c2.b;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cbar, 7) / (Math.pow(Cbar, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = C1p === 0 ? 0 : ((Math.atan2(b1, a1p) / deg) + 360) % 360;
  const h2p = C2p === 0 ? 0 : ((Math.atan2(b2, a2p) / deg) + 360) % 360;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp: number;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else dhp = h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * deg);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp: number;
  if (C1p * C2p === 0) hbp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbp = (h1p + h2p + 360) / 2;
  else hbp = (h1p + h2p - 360) / 2;
  const T = 1 - 0.17 * Math.cos((hbp - 30) * deg) + 0.24 * Math.cos(2 * hbp * deg) + 0.32 * Math.cos((3 * hbp + 6) * deg) - 0.2 * Math.cos((4 * hbp - 63) * deg);
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * deg) * Rc;
  return Math.sqrt(Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh));
}

// ---- named colours ------------------------------------------------------------------

export interface NamedColor {
  name: string;
  hex: string;
  lab: Lab;
}

const NAMED_HEX: Array<[string, string]> = [
  ["black", "#111111"],
  ["white", "#f4f4f4"],
  ["gray", "#808080"],
  ["red", "#d62828"],
  ["orange", "#f77f00"],
  ["yellow", "#f5d000"],
  ["green", "#2a9d3f"],
  ["lime", "#9bdc28"],
  ["teal", "#1f9e93"],
  ["cyan", "#3cc8e8"],
  ["sky", "#8ec8f0"],
  ["blue", "#2a5fd1"],
  ["navy", "#1b2a5c"],
  ["purple", "#7b3fbf"],
  ["magenta", "#d63ba8"],
  ["pink", "#f5a3c7"],
  ["brown", "#7a4a26"],
  ["tan", "#d2b48c"],
  ["olive", "#7a7a2a"],
  ["maroon", "#6e1a2a"],
];

export const NAMED_COLORS: NamedColor[] = NAMED_HEX.map(([name, hex]) => {
  const [r, g, b] = parseHex(hex);
  return { name, hex, lab: rgbToLab(r, g, b) };
});

export const COLOR_NAMES: string[] = NAMED_COLORS.map((c) => c.name);

export function nearestNamed(lab: Lab): NamedColor {
  let best = NAMED_COLORS[0];
  let bestD = Infinity;
  for (const c of NAMED_COLORS) {
    const d = deltaE2000(lab, c.lab);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

// ---- palette reduction ------------------------------------------------------------------

export interface PaletteEntry {
  hex: string;
  /** share of counted (non-background) pixels, 0..1 */
  share: number;
  L: number;
  a: number;
  b: number;
}

export interface Cluster {
  lab: Lab;
  weight: number;
  members: PaletteEntry[];
}

/**
 * Greedy agglomeration in Lab: entries are visited by descending coverage and join the first
 * cluster whose centroid is within `threshold` ΔE2000, else start a new one.
 * Pixel art palettes are exact, so this is cheap and deterministic; k-means is not needed.
 */
export function clusterPalette(entries: PaletteEntry[], threshold = 12): Cluster[] {
  const clusters: Cluster[] = [];
  const sorted = [...entries].sort((x, y) => y.share - x.share);
  for (const e of sorted) {
    const lab = { L: e.L, a: e.a, b: e.b };
    let target: Cluster | null = null;
    let bestD = threshold;
    for (const c of clusters) {
      const d = deltaE2000(lab, c.lab);
      if (d < bestD) {
        bestD = d;
        target = c;
      }
    }
    if (!target) {
      clusters.push({ lab: { ...lab }, weight: e.share, members: [e] });
    } else {
      const w = target.weight + e.share;
      target.lab = {
        L: (target.lab.L * target.weight + lab.L * e.share) / w,
        a: (target.lab.a * target.weight + lab.a * e.share) / w,
        b: (target.lab.b * target.weight + lab.b * e.share) / w,
      };
      target.weight = w;
      target.members.push(e);
    }
  }
  return clusters.sort((x, y) => y.weight - x.weight);
}

export interface Bucket {
  name: string;
  weight: number;
}

/** Snap clusters to the named vocabulary and aggregate weights per name (normalised to 1). */
export function bucketize(clusters: Cluster[]): Bucket[] {
  const acc = new Map<string, number>();
  let total = 0;
  for (const c of clusters) {
    const n = nearestNamed(c.lab).name;
    acc.set(n, (acc.get(n) ?? 0) + c.weight);
    total += c.weight;
  }
  if (total === 0) return [];
  return [...acc.entries()].map(([name, w]) => ({ name, weight: w / total })).sort((x, y) => y.weight - x.weight);
}
