import type { schemas } from "../../services/api-client";
import type { AdapterContext } from "../../services/wire";
import { normaliseBanners, type ArtVariant, type HomeBannerWire, type HomeBannersData, type HomeBannersPort } from "./model";

/** Wire art hints (warm/cool/neutral/festive) to the app's hero art variants. */
const ART: Record<NonNullable<schemas.HomeBannerItem["art_variant"]>, ArtVariant> = {
  warm: "sale",
  cool: "tide",
  neutral: "atelier",
  festive: "eid",
};

function toWire(i: schemas.HomeBannerItem): HomeBannerWire {
  const c = i.cta;
  return {
    id: i.id,
    title: i.title,
    ...(i.subtitle !== undefined ? { subtitle: i.subtitle } : {}),
    ...(i.image_url !== undefined ? { image_url: i.image_url } : {}),
    ...(i.art_variant !== undefined ? { art_variant: ART[i.art_variant] } : {}),
    sponsored: i.sponsored,
    starts_at: i.starts_at,
    ends_at: i.ends_at,
    cta: {
      kind: c.kind,
      ...("target_id" in c ? { target_id: c.target_id } : {}),
      ...("query" in c ? { query: c.query } : {}),
      ...("price_min" in c && c.price_min !== undefined ? { price_min: c.price_min } : {}),
      ...("price_max" in c && c.price_max !== undefined ? { price_max: c.price_max } : {}),
    },
  };
}

/**
 * API adapter for `listHomeBanners` (GET /v1/home/banners). Never throws into Home: on any failure it returns
 * the last good list (or an empty one). Uses ETag/If-None-Match; a 304 reuses the last list with the server
 * clock advanced by the elapsed time since that response (the device clock is only used as a stopwatch).
 */
export class ApiHomeBannersPort implements HomeBannersPort {
  private last: { readonly data: HomeBannersData; readonly etag: string | null; readonly atDeviceMs: number } | null = null;
  constructor(private readonly ctx: AdapterContext) {}

  async load(): Promise<HomeBannersData> {
    const prev = this.last;
    try {
      const opts = prev !== null && prev.etag !== null ? { headers: { "If-None-Match": prev.etag } } : {};
      // Signed out: GET /v1/public/home/banners (no bearer). The two lists have the same item shape.
      const res = (await this.ctx.isGuest?.()) === true ? await this.ctx.client.listPublicHomeBanners(opts) : await this.ctx.client.listHomeBanners(opts);
      const now = this.ctx.nowMs();
      if (res.notModified) {
        if (prev === null) return this.empty();
        const data = { ...prev.data, serverNowMs: prev.data.serverNowMs + Math.max(0, now - prev.atDeviceMs) };
        this.last = { data, etag: res.etag ?? prev.etag, atDeviceMs: now };
        return data;
      }
      const data = normaliseBanners({ items: res.data.items.map(toWire), server_time: "server_time" in res.data && typeof res.data.server_time === "string" ? res.data.server_time : new Date(now).toISOString() });
      this.last = { data, etag: res.etag, atDeviceMs: now };
      return data;
    } catch {
      if (prev === null) return this.empty();
      return { ...prev.data, serverNowMs: prev.data.serverNowMs + Math.max(0, this.ctx.nowMs() - prev.atDeviceMs) };
    }
  }

  private empty(): HomeBannersData {
    return { serverNowMs: this.ctx.nowMs(), banners: [] };
  }
}
