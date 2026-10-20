import { SellerSettingsError } from "./errors";

export const IMAGE_SLOTS = ["logo", "cover", "product"] as const;
export type ImageSlot = (typeof IMAGE_SLOTS)[number];
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export interface ImageLimits {
  readonly maxBytes: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
}

export const IMAGE_LIMITS: Readonly<Record<ImageSlot, ImageLimits>> = {
  logo: { maxBytes: 2_000_000, minWidth: 256, minHeight: 256, maxWidth: 4096, maxHeight: 4096 },
  cover: { maxBytes: 5_000_000, minWidth: 1200, minHeight: 300, maxWidth: 6000, maxHeight: 3000 },
  product: { maxBytes: 8_000_000, minWidth: 500, minHeight: 500, maxWidth: 8000, maxHeight: 8000 },
};

export const MAX_BULK_UPLOADS = 20;
export const UPLOAD_URL_TTL_SECONDS = 600;

export const EXTENSION: Readonly<Record<ImageType, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export interface ImageFacts {
  readonly type: ImageType;
  readonly width: number;
  readonly height: number;
}

const u16be = (b: Uint8Array, o: number): number => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const u32be = (b: Uint8Array, o: number): number => (u16be(b, o) * 65536 + u16be(b, o + 2)) >>> 0;
const u24le = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
const ascii = (b: Uint8Array, o: number, n: number): string => String.fromCharCode(...b.slice(o, o + n));

/**
 * Magic-byte sniff and dimension parse from the first bytes of an object. The declared content type is
 * never trusted: only the bytes decide. Returns null for anything that is not a plain JPEG, PNG or WebP.
 */
export function sniffImage(head: Uint8Array): ImageFacts | null {
  if (head.length >= 24 && head[0] === 0x89 && ascii(head, 1, 3) === "PNG" && ascii(head, 12, 4) === "IHDR") {
    return { type: "image/png", width: u32be(head, 16), height: u32be(head, 20) };
  }
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    let o = 2;
    while (o + 9 < head.length) {
      if (head[o] !== 0xff) return null;
      const marker = head[o + 1] ?? 0;
      if (marker === 0xff) {
        o += 1;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "image/jpeg", height: u16be(head, o + 5), width: u16be(head, o + 7) };
      }
      o += 2 + u16be(head, o + 2);
    }
    return null;
  }
  if (head.length >= 30 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") {
    const chunk = ascii(head, 12, 4);
    if (chunk === "VP8X") return { type: "image/webp", width: u24le(head, 24) + 1, height: u24le(head, 27) + 1 };
    if (chunk === "VP8L" && head[20] === 0x2f) {
      const bits = (head[21] ?? 0) | ((head[22] ?? 0) << 8) | ((head[23] ?? 0) << 16) | ((head[24] ?? 0) << 24);
      return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") {
      return { type: "image/webp", width: u16le14(head, 26), height: u16le14(head, 28) };
    }
  }
  return null;
}
const u16le14 = (b: Uint8Array, o: number): number => ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)) & 0x3fff;

export function validateUploadRequest(slot: ImageSlot, contentType: string, byteSize: number): ImageType {
  if (!(IMAGE_TYPES as readonly string[]).includes(contentType)) throw new SellerSettingsError("image_type_not_allowed");
  if (!Number.isInteger(byteSize) || byteSize <= 0) throw new SellerSettingsError("image_size_invalid");
  if (byteSize > IMAGE_LIMITS[slot].maxBytes) throw new SellerSettingsError("image_too_large");
  return contentType as ImageType;
}

export function validateImageFacts(
  slot: ImageSlot,
  declaredType: ImageType,
  actualBytes: number,
  facts: ImageFacts | null,
): ImageFacts {
  const l = IMAGE_LIMITS[slot];
  if (facts === null) throw new SellerSettingsError("image_content_not_allowed");
  if (facts.type !== declaredType) throw new SellerSettingsError("image_type_mismatch");
  if (actualBytes > l.maxBytes) throw new SellerSettingsError("image_too_large");
  if (facts.width < l.minWidth || facts.height < l.minHeight) throw new SellerSettingsError("image_dimensions_too_small");
  if (facts.width > l.maxWidth || facts.height > l.maxHeight) throw new SellerSettingsError("image_dimensions_too_large");
  return facts;
}

/** Object keys carry the store id and an unguessable upload id, never a file name or personal data. */
export function objectKeyFor(storeId: string, slot: ImageSlot, uploadId: string, type: ImageType): string {
  return `stores/${storeId}/${slot}/${uploadId}.${EXTENSION[type]}`;
}
export function keyBelongsToStore(key: string, storeId: string): boolean {
  return key.startsWith(`stores/${storeId}/`) && !key.includes("..");
}
