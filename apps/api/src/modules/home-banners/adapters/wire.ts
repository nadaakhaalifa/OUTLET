import type { BannerCta, HomeBanner } from "../domain/banner";
import { sponsoredLabel } from "../domain/banner";
import type { AdminBannerView } from "../application/banners";
import type { BannerImageUrlPort } from "../domain/ports";

const iso = (ms: number): string => new Date(ms).toISOString();

export function ctaWire(c: BannerCta) {
  switch (c.kind) {
    case "drop":
    case "store":
    case "voucher":
      return { kind: c.kind, target_id: c.targetId };
    case "category":
      return {
        kind: c.kind,
        target_id: c.targetId,
        ...(c.priceMin === null ? {} : { price_min: Number(c.priceMin) }),
        ...(c.priceMax === null ? {} : { price_max: Number(c.priceMax) }),
      };
    case "search":
      return {
        kind: c.kind,
        query: c.query,
        ...(c.priceMin === null ? {} : { price_min: Number(c.priceMin) }),
        ...(c.priceMax === null ? {} : { price_max: Number(c.priceMax) }),
      };
  }
}

const text = (ar: string, en: string | null) => ({ ar, ...(en === null ? {} : { en }) });

/** Shopper projection: allow-listed, no sponsor reference, no actor ids, no status, no version. */
export function publicWire(b: HomeBanner, images: BannerImageUrlPort, nowMs: number) {
  const url = b.imageKey === null ? null : images.urlFor(b.imageKey, nowMs);
  return {
    id: b.id,
    title: text(b.titleAr, b.titleEn),
    ...(b.subtitleAr === null ? {} : { subtitle: text(b.subtitleAr, b.subtitleEn) }),
    ...(url === null ? {} : { image_url: url }),
    ...(b.artVariant === null ? {} : { art_variant: b.artVariant }),
    sponsored: b.sponsored,
    starts_at: iso(b.startsAtMs),
    ends_at: iso(b.endsAtMs),
    cta: ctaWire(b.cta),
  };
}

export function adminWire(v: AdminBannerView, images: BannerImageUrlPort, nowMs: number) {
  const b = v.banner;
  const url = b.imageKey === null ? null : images.urlFor(b.imageKey, nowMs);
  return {
    id: b.id,
    status: b.status,
    lifecycle: v.lifecycle,
    title: text(b.titleAr, b.titleEn),
    ...(b.subtitleAr === null ? {} : { subtitle: text(b.subtitleAr, b.subtitleEn) }),
    ...(b.imageKey === null ? {} : { image_key: b.imageKey }),
    ...(url === null ? {} : { image_url: url }),
    ...(b.artVariant === null ? {} : { art_variant: b.artVariant }),
    priority: b.priority,
    starts_at: iso(b.startsAtMs),
    ends_at: iso(b.endsAtMs),
    sponsored: b.sponsored,
    sponsor_label: sponsoredLabel(b),
    ...(b.sponsorRef === null ? {} : { sponsor_ref: b.sponsorRef }),
    cta: ctaWire(b.cta),
    created_by: b.createdBy,
    updated_by: b.updatedBy,
    version: b.version,
    created_at: iso(b.createdAtMs),
    updated_at: iso(b.updatedAtMs),
  };
}
