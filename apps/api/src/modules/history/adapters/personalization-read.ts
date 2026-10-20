import type { UserFeatures } from "../domain/bridge";
import { featuresAreFresh } from "../domain/bridge";
import type { Clock, HistoryStore, PersonalizationConsentPort } from "../domain/ports";

/**
 * Read side consumed by the recommendations module (structurally its PersonalizationReadPort).
 * Stale features are not served: a feature set older than 24h fails closed to non-personal.
 */
export class HistoryPersonalizationRead {
  constructor(
    private readonly store: HistoryStore,
    private readonly consent: PersonalizationConsentPort,
    private readonly clock: Clock,
  ) {}

  settings(userId: string) {
    return this.store.getSettings(userId);
  }

  consentGranted(userId: string): Promise<boolean> {
    return this.consent.isGranted(userId);
  }

  async features(userId: string): Promise<UserFeatures | null> {
    const f = await this.store.getFeatures(userId);
    if (f === null || !featuresAreFresh(f.features, this.clock.nowMs())) return null;
    return f.features;
  }

  async recentViews(userId: string, limit: number) {
    const rows = await this.store.listRecentlyViewed(userId, limit);
    return rows.map((r) => ({ productId: r.productId, priceMinor: r.priceMinor, viewedAtMs: r.viewedAtMs }));
  }

  async purchases(userId: string, limit: number) {
    const bought = await this.store.listEvents(userId, "bought", null, limit);
    const returned = new Set((await this.store.listEvents(userId, "returned", null, limit)).flatMap((e) => (e.itemId === null ? [] : [e.itemId])));
    return bought.flatMap((e) =>
      e.itemId === null ? [] : [{ productId: e.itemId, boughtAtMs: e.atMs, returned: returned.has(e.itemId) }],
    );
  }
}
