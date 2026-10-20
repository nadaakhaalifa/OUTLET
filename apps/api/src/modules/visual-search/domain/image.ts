/**
 * Pure image-bytes helpers for the query path (no codecs, no dependencies): magic-byte sniffing,
 * dimension reading for the pixel cap, and metadata stripping (EXIF, XMP, GPS, comments, ICC).
 * Only JPEG, PNG and WebP are accepted. Pixel data is never decoded or altered here.
 */
import type { ImageMime } from "./ports";

export type ImageReject = "unsupported_type" | "malformed" | "too_large_bytes" | "too_large_dimensions";

export type Sanitized =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly mime: ImageMime; readonly width: number; readonly height: number; readonly strippedBytes: number }
  | { readonly ok: false; readonly reason: ImageReject };

export function sniff(b: Uint8Array): ImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "image/png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  return null;
}

const ascii = (b: Uint8Array, s: number, e: number): string => String.fromCharCode(...b.subarray(s, e));
const u16 = (b: Uint8Array, o: number): number => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const u32 = (b: Uint8Array, o: number): number => (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;
const le32 = (b: Uint8Array, o: number): number => ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0;
const le24 = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);

type Result = { readonly bytes: Uint8Array; readonly width: number; readonly height: number } | null;

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Keeps APP0 (JFIF) and APP14 (Adobe colour transform). Drops APP1..APP13, APP15 and COM. */
function stripJpeg(b: Uint8Array): Result {
  const kept: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  let width = 0;
  let height = 0;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1] ?? 0;
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0xd9) {
      kept.push(b.subarray(i, i + 2));
      return width > 0 ? { bytes: concat(kept), width, height } : null;
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      kept.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = u16(b, i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof) {
      if (len < 8) return null;
      height = u16(b, i + 5);
      width = u16(b, i + 7);
    }
    if (m === 0xda) {
      // Start of scan: entropy coded data to the end of the file is copied verbatim.
      kept.push(b.subarray(i));
      return width > 0 && height > 0 ? { bytes: concat(kept), width, height } : null;
    }
    const drop = (m >= 0xe1 && m <= 0xed) || m === 0xef || m === 0xfe;
    if (!drop) kept.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "sBIT", "bKGD"]);

function stripPng(b: Uint8Array): Result {
  const kept: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  let width = 0;
  let height = 0;
  let sawEnd = false;
  while (i + 12 <= b.length) {
    const len = u32(b, i);
    const type = ascii(b, i + 4, i + 8);
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (type === "IHDR") {
      if (len !== 13) return null;
      width = u32(b, i + 8);
      height = u32(b, i + 12);
    }
    if (PNG_KEEP.has(type)) kept.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  return sawEnd && width > 0 && height > 0 ? { bytes: concat(kept), width, height } : null;
}

function stripWebp(b: Uint8Array): Result {
  const total = le32(b, 4) + 8;
  if (total > b.length || total < 20) return null;
  const chunks: Uint8Array[] = [];
  let i = 12;
  let width = 0;
  let height = 0;
  while (i + 8 <= total) {
    const type = ascii(b, i, i + 4);
    const len = le32(b, i + 4);
    const padded = len + (len & 1);
    const end = i + 8 + padded;
    if (end > total) return null;
    let chunk = b.subarray(i, end);
    if (type === "VP8X") {
      if (len < 10) return null;
      width = le24(b, i + 12) + 1;
      height = le24(b, i + 15) + 1;
      const c = new Uint8Array(chunk);
      c[8] = (c[8] ?? 0) & ~0x2c; // clear ICC (0x20), EXIF (0x08) and XMP (0x04) flags
      chunk = c;
    } else if (type === "VP8 ") {
      if (len < 10 || b[i + 11] !== 0x9d || b[i + 12] !== 0x01 || b[i + 13] !== 0x2a) return null;
      width = ((b[i + 14] ?? 0) | ((b[i + 15] ?? 0) << 8)) & 0x3fff;
      height = ((b[i + 16] ?? 0) | ((b[i + 17] ?? 0) << 8)) & 0x3fff;
    } else if (type === "VP8L") {
      if (len < 5 || b[i + 8] !== 0x2f) return null;
      const v = le32(b, i + 9);
      width = (v & 0x3fff) + 1;
      height = ((v >>> 14) & 0x3fff) + 1;
    }
    if (type !== "EXIF" && type !== "XMP " && type !== "ICCP") chunks.push(chunk);
    i = end;
  }
  if (width === 0 || height === 0) return null;
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 12));
  const size = body.length + 4;
  header[4] = size & 0xff;
  header[5] = (size >>> 8) & 0xff;
  header[6] = (size >>> 16) & 0xff;
  header[7] = (size >>> 24) & 0xff;
  return { bytes: concat([header, body]), width, height };
}

/** Sniff, bound size and pixels, then strip metadata. Never trusts the declared content type. */
export function sanitizeImage(input: Uint8Array, limits: { readonly maxBytes: number; readonly maxDimension: number }): Sanitized {
  if (input.length > limits.maxBytes) return { ok: false, reason: "too_large_bytes" };
  const mime = sniff(input);
  if (mime === null) return { ok: false, reason: "unsupported_type" };
  const r = mime === "image/jpeg" ? stripJpeg(input) : mime === "image/png" ? stripPng(input) : stripWebp(input);
  if (r === null) return { ok: false, reason: "malformed" };
  if (r.width > limits.maxDimension || r.height > limits.maxDimension) return { ok: false, reason: "too_large_dimensions" };
  return { ok: true, bytes: r.bytes, mime, width: r.width, height: r.height, strippedBytes: input.length - r.bytes.length };
}
