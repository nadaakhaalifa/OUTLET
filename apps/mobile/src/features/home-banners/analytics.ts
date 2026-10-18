import type { BannerAnalyticsEvent, BannerAnalyticsPort } from "./model";

/** The slice of ClientAnalytics this adapter needs (consent gating lives inside `track`). */
export interface BannerTrackSink {
  track(
    name: "home_banner_impression" | "home_banner_click",
    properties: { banner_id: string; position: number; sponsored: boolean; cta_kind: BannerAnalyticsEvent["kind"] },
  ): Promise<boolean>;
}

/**
 * Forwards banner impressions and clicks to the consent-gated client analytics. Nothing is sent before the
 * `analytics` consent (ClientAnalytics has no tracker until then, and `track` resolves false). Fire and forget:
 * never throws into the UI. Properties are opaque id, slot, sponsored flag and cta kind only.
 */
export class ClientBannerAnalytics implements BannerAnalyticsPort {
  constructor(private readonly sink: BannerTrackSink) {}
  impression(e: BannerAnalyticsEvent): void {
    this.send("home_banner_impression", e);
  }
  click(e: BannerAnalyticsEvent): void {
    this.send("home_banner_click", e);
  }
  private send(name: "home_banner_impression" | "home_banner_click", e: BannerAnalyticsEvent): void {
    void this.sink
      .track(name, { banner_id: e.bannerId, position: e.position, sponsored: e.sponsored, cta_kind: e.kind })
      .catch(() => false);
  }
}
