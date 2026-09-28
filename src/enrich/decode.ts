// Format sniffing + decoding to RGBA. WebP first (what Pixagram writes), PNG second.
//
// The WASM codecs (jSquash) are initialised once per isolate with modules injected by the
// caller: the Worker passes `import x from "*.wasm"` modules; tests compile them from disk.

import webpDecode, { init as initWebpDecode } from "@jsquash/webp/decode";
import pngDecode, { init as initPngDecode } from "@jsquash/png/decode";
import pngEncode, { init as initPngEncode } from "@jsquash/png/encode";

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel */
  data: Uint8Array;
}

export interface ContainerInfo {
  format: "webp" | "png" | "unknown";
  mime: string;
  /** WebP VP8 (lossy) — colour statistics are approximate */
  lossy: boolean;
  /** Declared alpha (WebP VP8X flag / PNG colour type); the decoded pixels are authoritative */
  alphaDeclared: boolean;
  width: number | null;
  height: number | null;
}

let wasmReady: Promise<void> | null = null;

export interface CodecModules {
  webpDecode: WebAssembly.Module;
  png: WebAssembly.Module;
}

/** Register the WASM modules. Safe to call repeatedly; the first call wins. */
export function initCodecs(mods: CodecModules): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      await initWebpDecode(mods.webpDecode);
      await initPngDecode(mods.png);
      await initPngEncode(mods.png);
    })();
  }
  return wasmReady;
}

// ---- sniffing ----------------------------------------------------------------------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(b: Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i]);
  return s;
}

function u32le(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

function u24le(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8) | (b[off + 2] << 16);
}

function u32be(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

/** Inspect the container without decoding. */
export function sniff(bytes: Uint8Array): ContainerInfo {
  const unknown: ContainerInfo = { format: "unknown", mime: "application/octet-stream", lossy: false, alphaDeclared: false, width: null, height: null };
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const info: ContainerInfo = { format: "webp", mime: "image/webp", lossy: false, alphaDeclared: false, width: null, height: null };
    let off = 12;
    // Walk chunks: VP8X (extended, holds flags+dims) may precede VP8/VP8L (the bitstream).
    while (off + 8 <= bytes.length) {
      const fourcc = ascii(bytes, off, 4);
      const size = u32le(bytes, off + 4);
      const payload = off + 8;
      if (fourcc === "VP8X" && payload + 10 <= bytes.length) {
        const flags = bytes[payload];
        info.alphaDeclared = (flags & 0x10) !== 0;
        info.width = u24le(bytes, payload + 4) + 1;
        info.height = u24le(bytes, payload + 7) + 1;
      } else if (fourcc === "VP8 ") {
        info.lossy = true;
        if (info.width === null && payload + 10 <= bytes.length) {
          info.width = (bytes[payload + 6] | (bytes[payload + 7] << 8)) & 0x3fff;
          info.height = (bytes[payload + 8] | (bytes[payload + 9] << 8)) & 0x3fff;
        }
        break;
      } else if (fourcc === "VP8L") {
        info.lossy = false;
        if (payload + 5 <= bytes.length) {
          const bits = u32le(bytes, payload + 1);
          if (info.width === null) {
            info.width = (bits & 0x3fff) + 1;
            info.height = ((bits >>> 14) & 0x3fff) + 1;
          }
          info.alphaDeclared = info.alphaDeclared || ((bits >>> 28) & 1) === 1;
        }
        break;
      }
      off = payload + size + (size & 1);
    }
    return info;
  }
  if (bytes.length >= 29 && PNG_MAGIC.every((v, i) => bytes[i] === v) && ascii(bytes, 12, 4) === "IHDR") {
    const colorType = bytes[25];
    return {
      format: "png",
      mime: "image/png",
      lossy: false,
      alphaDeclared: colorType === 4 || colorType === 6 || colorType === 3, // palette may carry tRNS
      width: u32be(bytes, 16),
      height: u32be(bytes, 20),
    };
  }
  return unknown;
}

// ---- decoding ----------------------------------------------------------------------

export const MAX_PIXELS = 4096 * 4096;

export async function decodeImage(bytes: Uint8Array, info?: ContainerInfo): Promise<RgbaImage> {
  const c = info ?? sniff(bytes);
  if (c.width && c.height && c.width * c.height > MAX_PIXELS) throw new Error(`image too large: ${c.width}x${c.height}`);
  if (!wasmReady) throw new Error("codecs not initialised: call initCodecs() first");
  await wasmReady;
  const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
  let img: { width: number; height: number; data: Uint8ClampedArray | Uint8Array };
  if (c.format === "webp") img = await webpDecode(buf);
  else if (c.format === "png") img = await pngDecode(buf);
  else throw new Error(`unsupported image container (${c.mime})`);
  const data = img.data instanceof Uint8Array ? img.data : new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return { width: img.width, height: img.height, data };
}

export async function encodePng(img: RgbaImage): Promise<Uint8Array> {
  if (!wasmReady) throw new Error("codecs not initialised: call initCodecs() first");
  await wasmReady;
  const clamped = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const out = await pngEncode({ data: clamped, width: img.width, height: img.height } as any);
  return new Uint8Array(out);
}
