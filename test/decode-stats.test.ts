import { describe, expect, it, beforeAll } from "vitest";
import { codecsReady, fixture } from "./helpers";
import { decodeImage, encodePng, sniff } from "../src/enrich/decode";
import { computeStats } from "../src/enrich/stats";
import { hamming, phash, phashChunks } from "../src/enrich/phash";
import { factorFor, upscaleNearest, upscaleXbrz } from "../src/enrich/upscale";
import { sha256Hex } from "../src/lib/bytes";

beforeAll(() => codecsReady());

describe("sniff", () => {
  it("recognises the lossless WebP Pixagram writes", () => {
    const info = sniff(fixture("small.webp"));
    expect(info.format).toBe("webp");
    expect(info.lossy).toBe(false);
    expect(info.width).toBe(108);
    expect(info.height).toBe(134);
  });

  it("flags a lossy VP8 bitstream", () => {
    // RIFF....WEBPVP8 <size><3 bytes frame tag><start code 9d 01 2a><w><h>
    const b = new Uint8Array(30);
    const put = (s: string, off: number) => [...s].forEach((c, i) => (b[off + i] = c.charCodeAt(0)));
    put("RIFF", 0);
    put("WEBP", 8);
    put("VP8 ", 12);
    b[16] = 10;
    b[26] = 0x40; // width 64
    b[28] = 0x20; // height 32
    const info = sniff(b);
    expect(info.format).toBe("webp");
    expect(info.lossy).toBe(true);
    expect(info.width).toBe(64);
    expect(info.height).toBe(32);
  });

  it("recognises PNG headers", async () => {
    const img = await decodeImage(fixture("small.webp"));
    const png = await encodePng(img);
    const info = sniff(png);
    expect(info.format).toBe("png");
    expect(info.width).toBe(108);
    expect(info.height).toBe(134);
  });

  it("rejects other containers", () => {
    expect(sniff(new Uint8Array([1, 2, 3, 4])).format).toBe("unknown");
  });
});

describe("decode + native stats", () => {
  it("decodes a real artwork and counts its exact palette", async () => {
    const bytes = fixture("small.webp");
    const img = await decodeImage(bytes);
    expect(img.width * img.height * 4).toBe(img.data.length);
    const st = computeStats(img);
    expect(st.width).toBe(108);
    expect(st.height).toBe(134);
    expect(st.colorCount).toBe(4); // 4 opaque colours + a transparent backdrop (Pillow reports 5 RGBA tuples)
    expect(st.hasTransparency).toBe(true);
    expect(st.backgroundHex).toBeNull(); // transparent backdrop, not a colour
    expect(st.sizeClass).toBe("large");
    expect(st.buckets.length).toBeGreaterThan(0);
    expect(st.primaryColor).toBeTruthy();
    const total = st.buckets.reduce((s, b) => s + b.weight, 0);
    expect(total).toBeCloseTo(1, 2);
    expect(st.palette[0].share).toBeGreaterThanOrEqual(st.palette[st.palette.length - 1].share);
  });

  it("counts 41 colours on the second artwork", async () => {
    const img = await decodeImage(fixture("second.webp"));
    const st = computeStats(img);
    expect(st.width).toBe(224);
    expect(st.colorCount).toBe(41);
    expect(st.hasTransparency).toBe(false);
  });

  it("excludes a flat background from the primary colour and keeps it as background_hex", () => {
    // 20x20 white canvas with a 6x6 red square in the middle
    const w = 20, h = 20;
    const data = new Uint8Array(w * h * 4).fill(255);
    for (let y = 7; y < 13; y++) for (let x = 7; x < 13; x++) {
      const i = (y * w + x) * 4;
      data[i] = 214; data[i + 1] = 40; data[i + 2] = 40; data[i + 3] = 255;
    }
    const st = computeStats({ width: w, height: h, data });
    expect(st.backgroundHex).toBe("#ffffff");
    expect(st.primaryColor).toBe("red");
    expect(st.colorCount).toBe(2);
  });

  it("treats a transparent backdrop as background", () => {
    const w = 16, h = 16;
    const data = new Uint8Array(w * h * 4); // all transparent
    for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) {
      const i = (y * w + x) * 4;
      data[i] = 42; data[i + 1] = 95; data[i + 2] = 209; data[i + 3] = 255;
    }
    const st = computeStats({ width: w, height: h, data });
    expect(st.hasTransparency).toBe(true);
    expect(st.transparentShare).toBeCloseTo(0.75, 3);
    expect(st.primaryColor).toBe("blue");
    expect(st.backgroundHex).toBeNull();
  });
});

describe("pHash", () => {
  it("is stable and distance-0 to itself, small distance after nearest-neighbour upscale", async () => {
    const img = await decodeImage(fixture("small.webp"));
    const h1 = phash(img);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(hamming(h1, phash(img))).toBe(0);
    const up = upscaleNearest(img, 3);
    expect(hamming(h1, phash(up))).toBeLessThanOrEqual(6);
    const other = await decodeImage(fixture("second.webp"));
    expect(hamming(h1, phash(other))).toBeGreaterThan(10);
    expect(phashChunks(h1)).toHaveLength(8);
    expect(phashChunks(h1).every((v) => v >= 0 && v <= 255)).toBe(true);
  });
});

describe("upscale", () => {
  it("picks an integer factor that reaches the target, capped at 6", () => {
    expect(factorFor(108, 134, 800)).toBe(6);
    expect(factorFor(427, 240, 800)).toBe(2);
    expect(factorFor(224, 224, 800)).toBe(4);
    expect(factorFor(1200, 900, 800)).toBe(1);
    expect(factorFor(16, 16, 800)).toBe(6);
  });

  it("xBRZ produces the right dimensions and keeps flat regions exact", async () => {
    const img = await decodeImage(fixture("small.webp"));
    const f = factorFor(img.width, img.height, 800);
    const up = upscaleXbrz(img, f);
    expect(up.width).toBe(img.width * f);
    expect(up.height).toBe(img.height * f);
    expect(up.data.length).toBe(up.width * up.height * 4);
    // xBRZ only blends at edges; interior pixels of a flat region keep their exact colour.
    const st = computeStats(img);
    const stUp = computeStats(up);
    expect(stUp.colorCount).toBeGreaterThanOrEqual(st.colorCount);
    expect(stUp.primaryColor).toBe(st.primaryColor);
    const png = await encodePng(up);
    expect(sniff(png).format).toBe("png");
    expect(await sha256Hex(png)).toMatch(/^[0-9a-f]{64}$/);
  });
});
