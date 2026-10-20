import { describe, expect, it } from "vitest";
import { sanitizeImage, sniff } from "./image";
import { jpeg } from "../test/harness";

const limits = { maxBytes: 10 * 1024 * 1024, maxDimension: 4096 };
const chunk = (type: string, data: number[]): number[] => {
  const len = data.length;
  return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...Buffer.from(type), ...data, 0, 0, 0, 0];
};
const png = (w: number, h: number): Uint8Array =>
  Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [(w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, (h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, 8, 2, 0, 0, 0]),
    ...chunk("eXIf", [...Buffer.from("GPS-DATA")]),
    ...chunk("tEXt", [...Buffer.from("Comment\0secret")]),
    ...chunk("IDAT", [1, 2, 3]),
    ...chunk("IEND", []),
  ]);
const le = (n: number, bytes: number) => Array.from({ length: bytes }, (_, i) => (n >>> (8 * i)) & 255);
const webp = (w: number, h: number): Uint8Array => {
  const vp8x = [...Buffer.from("VP8X"), ...le(10, 4), 0x08 | 0x04, 0, 0, 0, ...le(w - 1, 3), ...le(h - 1, 3)];
  const exif = [...Buffer.from("EXIF"), ...le(8, 4), ...Buffer.from("GPS-DATA")];
  const body = [...Buffer.from("WEBP"), ...vp8x, ...exif];
  return Uint8Array.from([...Buffer.from("RIFF"), ...le(body.length, 4), ...body]);
};
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s));

describe("sanitizeImage", () => {
  it("sniffs by magic bytes, ignoring any declared type", () => {
    expect(sniff(jpeg(10, 10))).toBe("image/jpeg");
    expect(sniff(png(10, 10))).toBe("image/png");
    expect(sniff(webp(10, 10))).toBe("image/webp");
    expect(sniff(Uint8Array.from([0x47, 0x49, 0x46]))).toBeNull();
  });

  it("strips JPEG EXIF/GPS and comments, keeps JFIF and the scan, reads dimensions", () => {
    const src = jpeg(640, 480, 7);
    const r = sanitizeImage(src, limits);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.width).toBe(640);
    expect(r.height).toBe(480);
    expect(has(r.bytes, "GPSLatitude")).toBe(false);
    expect(has(r.bytes, "Exif")).toBe(false);
    expect(has(r.bytes, "made-by-phone")).toBe(false);
    expect(has(r.bytes, "JFIF")).toBe(true);
    expect(r.strippedBytes).toBeGreaterThan(0);
    expect(r.bytes.at(-2)).toBe(0xff);
    expect(r.bytes.at(-1)).toBe(0xd9);
  });

  it("strips PNG eXIf and text chunks", () => {
    const r = sanitizeImage(png(300, 200), limits);
    expect(r.ok && r.width === 300 && r.height === 200).toBe(true);
    if (r.ok) {
      expect(has(r.bytes, "GPS-DATA")).toBe(false);
      expect(has(r.bytes, "secret")).toBe(false);
      expect(has(r.bytes, "IDAT")).toBe(true);
    }
  });

  it("strips WebP EXIF, clears the VP8X flags and fixes the RIFF size", () => {
    const r = sanitizeImage(webp(320, 240), limits);
    expect(r.ok && r.width === 320 && r.height === 240).toBe(true);
    if (r.ok) {
      expect(has(r.bytes, "GPS-DATA")).toBe(false);
      expect(has(r.bytes, "EXIF")).toBe(false);
      const riff = (r.bytes[4] ?? 0) | ((r.bytes[5] ?? 0) << 8) | ((r.bytes[6] ?? 0) << 16);
      expect(riff).toBe(r.bytes.length - 8);
      expect((r.bytes[20] ?? 0) & 0x0c).toBe(0);
    }
  });

  it("rejects pixel bombs, oversized files, truncated and unknown data", () => {
    expect(sanitizeImage(jpeg(5000, 100), limits)).toEqual({ ok: false, reason: "too_large_dimensions" });
    expect(sanitizeImage(png(100, 8192), limits)).toEqual({ ok: false, reason: "too_large_dimensions" });
    expect(sanitizeImage(new Uint8Array(20), { ...limits, maxBytes: 10 })).toEqual({ ok: false, reason: "too_large_bytes" });
    expect(sanitizeImage(jpeg(10, 10).subarray(0, 12), limits)).toEqual({ ok: false, reason: "malformed" });
    expect(sanitizeImage(Uint8Array.from([0, 1, 2, 3]), limits)).toEqual({ ok: false, reason: "unsupported_type" });
  });
});
