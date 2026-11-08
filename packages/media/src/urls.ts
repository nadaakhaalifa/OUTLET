import { MediaError } from "./errors.js";
import type { MediaKind, Variant, VariantFormat } from "./pipeline.js";

export interface MediaAsset {
  readonly id: string;
  readonly marketId: string;
  readonly storeId: string | null;
  readonly kind: MediaKind;
  readonly status: "pending_scan" | "ready" | "rejected";
  readonly sha256: string;
  readonly mime: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly variants: readonly Variant[];
  readonly storageKey: string;
}

const assertPublic = (asset: MediaAsset): void => {
  if (asset.status !== "ready" || asset.kind === "document") throw new MediaError("not_ready", "asset has no public renditions");
};

/** CDN URL of a derived rendition. READY non-document assets only; originals are never public. */
export const publicVariantUrl = (asset: MediaAsset, variant: Variant, cdnBase: string): string => {
  assertPublic(asset);
  if (!asset.variants.some((v) => v.key === variant.key)) throw new MediaError("not_found", "variant not part of asset");
  return `${cdnBase.replace(/\/+$/, "")}/${variant.key}`;
};

export interface PictureSource {
  readonly type: string;
  readonly srcset: string;
  readonly sizes: string;
}
export interface PictureData {
  readonly sources: readonly PictureSource[];
  /** JPEG fallback for the <img>. */
  readonly img: { readonly src: string; readonly srcset: string; readonly sizes: string; readonly width: number; readonly height: number };
}

const MIME: Readonly<Record<VariantFormat, string>> = { avif: "image/avif", webp: "image/webp", jpeg: "image/jpeg" };

/** <picture>-ready data: AVIF then WebP sources, JPEG fallback img, explicit width/height of the largest rendition (CLS). */
export const srcset = (asset: MediaAsset, opts: { readonly sizes: string; readonly cdnBase: string }): PictureData => {
  assertPublic(asset);
  const forFormat = (f: VariantFormat): Variant[] => asset.variants.filter((v) => v.format === f).sort((a, b) => a.width - b.width);
  const set = (vs: readonly Variant[]): string => vs.map((v) => `${publicVariantUrl(asset, v, opts.cdnBase)} ${String(v.width)}w`).join(", ");
  const jpegs = forFormat("jpeg");
  const largest = jpegs[jpegs.length - 1];
  if (largest === undefined) throw new MediaError("not_ready", "no jpeg fallback");
  const sources = (["avif", "webp"] as const)
    .map((f) => ({ f, vs: forFormat(f) }))
    .filter(({ vs }) => vs.length > 0)
    .map(({ f, vs }) => ({ type: MIME[f], srcset: set(vs), sizes: opts.sizes }));
  return {
    sources,
    img: { src: publicVariantUrl(asset, largest, opts.cdnBase), srcset: set(jpegs), sizes: opts.sizes, width: largest.width, height: largest.height },
  };
};
