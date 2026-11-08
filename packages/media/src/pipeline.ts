import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import type { OutputInfo, Sharp } from "sharp";
import { MediaError } from "./errors.js";

export type MediaKind = "product" | "defect" | "brand_logo" | "storefront" | "document";
export type VariantFormat = "avif" | "webp" | "jpeg";

export interface Variant {
  readonly format: VariantFormat;
  readonly width: number;
  readonly height: number;
  readonly key: string;
  readonly bytes: number;
}

export const VARIANT_WIDTHS = [320, 640, 960, 1280] as const;
/** The above-the-fold rendition (BUILD-PROMPT section 3: <= 400 KB per PDP, so each format of this one is capped). */
export const ABOVE_FOLD_WIDTH = 640;
export const ABOVE_FOLD_MAX_BYTES = 100 * 1024;
export const MAX_BYTES: Readonly<Record<MediaKind, number>> = {
  product: 10 * 1024 * 1024,
  defect: 10 * 1024 * 1024,
  brand_logo: 10 * 1024 * 1024,
  storefront: 10 * 1024 * 1024,
  document: 20 * 1024 * 1024,
};
const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/heic"];
const MAX_INPUT_PIXELS = 50_000_000;
const MIME_ALIASES: Readonly<Record<string, string>> = { "image/heif": "image/heic" };

const QUALITY_STEPS: Readonly<Record<VariantFormat, readonly number[]>> = {
  avif: [60, 50, 42, 34, 28, 22, 16],
  webp: [80, 70, 60, 50, 40, 30, 20],
  jpeg: [82, 72, 62, 52, 42, 32, 22],
};
const EXT: Readonly<Record<VariantFormat, string>> = { avif: "avif", webp: "webp", jpeg: "jpg" };
export const CONTENT_TYPE: Readonly<Record<VariantFormat, string>> = { avif: "image/avif", webp: "image/webp", jpeg: "image/jpeg" };
const FORMATS: readonly VariantFormat[] = ["avif", "webp", "jpeg"];

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const normaliseMime = (m: string): string => {
  const base = (m.split(";")[0] ?? "").trim().toLowerCase();
  return MIME_ALIASES[base] ?? base;
};

/** Size cap, then magic-byte sniff; the declared type must equal the sniffed one and be allowed for the kind. */
export const sniff = async (bytes: Uint8Array, declaredMime: string, kind: MediaKind): Promise<string> => {
  if (bytes.byteLength === 0) throw new MediaError("invalid_image", "empty upload");
  if (bytes.byteLength > MAX_BYTES[kind]) throw new MediaError("too_large");
  const found = await fileTypeFromBuffer(bytes);
  const sniffed = found === undefined ? "" : normaliseMime(found.mime);
  const allowed = kind === "document" ? ["application/pdf"] : IMAGE_MIMES;
  if (!allowed.includes(sniffed)) throw new MediaError("type_not_allowed", `content type ${sniffed === "" ? "unknown" : sniffed} not allowed for ${kind}`);
  if (normaliseMime(declaredMime) !== sniffed) throw new MediaError("mime_mismatch", "declared type does not match content");
  return sniffed;
};

export interface Rendition extends Omit<Variant, "key"> {
  readonly data: Uint8Array;
}
export interface ProcessedImage {
  readonly width: number;
  readonly height: number;
  /** Full-size, metadata-free, sRGB master (JPEG q90). Stored in the private bucket instead of the raw upload. */
  readonly master: Uint8Array;
  readonly renditions: readonly Rendition[];
}

const encode = (img: Sharp, format: VariantFormat, quality: number): Promise<{ data: Buffer; info: OutputInfo }> => {
  switch (format) {
    case "avif":
      return img.clone().avif({ quality, effort: 2 }).toBuffer({ resolveWithObject: true });
    case "webp":
      return img.clone().webp({ quality }).toBuffer({ resolveWithObject: true });
    case "jpeg":
      return img.clone().jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  }
};

/** Decode, apply EXIF orientation, drop ALL metadata (sharp strips by default; ICC is converted to sRGB), render variants. */
export const processImage = async (bytes: Uint8Array): Promise<ProcessedImage> => {
  try {
    const base = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).rotate().toColourspace("srgb");
    const { data: masterBuf, info } = await base.clone().jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
    const widths: number[] = VARIANT_WIDTHS.filter((w) => w <= info.width);
    if (widths.length === 0) widths.push(info.width); // smaller than the smallest step: one variant at native width
    const renditions: Rendition[] = [];
    for (const w of widths) {
      for (const format of FORMATS) {
        const resized = sharp(masterBuf).resize({ width: w, withoutEnlargement: true });
        const steps = w === ABOVE_FOLD_WIDTH ? QUALITY_STEPS[format] : [QUALITY_STEPS[format][0] ?? 60];
        let chosen: { data: Buffer; info: OutputInfo } | undefined;
        for (const q of steps) {
          chosen = await encode(resized, format, q);
          if (w !== ABOVE_FOLD_WIDTH || chosen.data.byteLength <= ABOVE_FOLD_MAX_BYTES) break;
        }
        if (chosen === undefined) throw new MediaError("invalid_image");
        if (w === ABOVE_FOLD_WIDTH && chosen.data.byteLength > ABOVE_FOLD_MAX_BYTES) throw new MediaError("variant_too_large", `${format} ${String(w)}w exceeds cap`);
        renditions.push({ format, width: chosen.info.width, height: chosen.info.height, bytes: chosen.data.byteLength, data: chosen.data });
      }
    }
    return { width: info.width, height: info.height, master: masterBuf, renditions };
  } catch (e) {
    if (e instanceof MediaError) throw e;
    throw new MediaError("invalid_image", "image could not be decoded");
  }
};

export const variantKey = (prefix: string, format: VariantFormat, width: number): string => `${prefix}/${format}-${String(width)}.${EXT[format]}`;
