// Byte helpers that work in Workers, Node and browsers without Buffer.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Uint8Array(256).fill(255);
for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;
B64_LOOKUP["-".charCodeAt(0)] = 62; // url-safe variants
B64_LOOKUP["_".charCodeAt(0)] = 63;

/** Decode base64 (standard or url-safe, whitespace tolerated) into bytes. */
export function base64Decode(s: string): Uint8Array {
  let len = s.length;
  // count valid chars
  let n = 0;
  for (let i = 0; i < len; i++) if (B64_LOOKUP[s.charCodeAt(i)] !== 255) n++;
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    const v = B64_LOOKUP[s.charCodeAt(i)];
    if (v === 255) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}

/** Encode bytes as standard base64. */
export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const rem = bytes.length - i;
    const n = (bytes[i] << 16) | (rem === 2 ? bytes[i + 1] << 8 : 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (rem === 2 ? B64[(n >> 6) & 63] : "=") + "=";
  }
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return hex(new Uint8Array(digest));
}

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function toDataUri(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${base64Encode(bytes)}`;
}

/** Ensure a Uint8Array is backed by its own ArrayBuffer (some WASM APIs want exactly that). */
export function ownBuffer(u8: Uint8Array): ArrayBuffer {
  if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer as ArrayBuffer;
  return u8.slice().buffer as ArrayBuffer;
}
