import {
  cairoDayKey,
  matchesTargeting,
  runAuction,
  startOfCairoDayMs,
  type AuctionCandidate,
  type TargetingContext,
} from "../domain/bridge";
import type { ImpressionRecord } from "../domain/ports";
import { configOf, sha256Hex, type AdsDeps } from "./shared";

export interface SponsoredSelection {
  readonly campaignId: string;
  readonly productId: string;
  readonly storeId: string;
  readonly position: number;
  readonly impressionId: string;
  /** Signed, single use, bound to the session. Send it back on a click. */
  readonly clickToken: string;
  readonly sponsored: true;
}

export const sessionHashOf = (d: AdsDeps, sessionId: string): Promise<string> => d.secret.hmac(`ad-session:${sessionId}`);

/** `jti.impressionId.price.issuedAtMs.sig`: the price the auction decided is part of what is signed. */
export async function signClickToken(
  d: AdsDeps,
  p: { jti: string; impressionId: string; campaignId: string; productId: string; sessionHash: string; price: bigint; issuedAtMs: number },
): Promise<string> {
  const sig = (
    await d.secret.hmac(`ad-click:${p.jti}:${p.impressionId}:${p.campaignId}:${p.productId}:${p.sessionHash}:${p.price}:${p.issuedAtMs}`)
  ).slice(0, 40);
  return `${p.jti}.${p.impressionId}.${p.price}.${p.issuedAtMs}.${sig}`;
}

/**
 * Internal service use case (never an HTTP route): picks sponsored candidates for one search or
 * category request. Targeting reads only query, category, store scope and locale (TargetingContext
 * has no field for anything else). The search module still applies its own "max 2 in the top 10"
 * cap to whatever is returned; this module only supplies candidates.
 */
export class SelectSponsored {
  constructor(private readonly d: AdsDeps) {}

  async execute(input: { readonly ctx: TargetingContext; readonly sessionId: string }): Promise<readonly SponsoredSelection[]> {
    const d = this.d;
    if (!(await d.flags.sponsoredEnabled())) return [];
    const cfg = await configOf(d);
    if (cfg.slots <= 0) return [];
    const nowMs = d.clock.nowMs();
    const dayKey = cairoDayKey(nowMs);
    const servable = await d.store.listServable(nowMs, dayKey);
    if (servable.length === 0) return [];

    const blocked = await d.enforcement.blockedStores([...new Set(servable.map((s) => s.campaign.storeId))]);
    const live = servable.filter((s) => !blocked.has(s.campaign.storeId));
    const facts = new Map(
      (await d.eligibility.facts([...new Set(live.map((s) => s.productId))], input.ctx)).map((f) => [f.productId, f]),
    );
    const sessionHash = await sessionHashOf(d, input.sessionId);
    const dayStart = startOfCairoDayMs(nowMs);
    const capped = new Map<string, boolean>();
    const overCap = async (campaignId: string): Promise<boolean> => {
      const hit = capped.get(campaignId);
      if (hit !== undefined) return hit;
      const n = await d.store.impressionsTodayBySession(sessionHash, campaignId, dayStart);
      const over = n >= cfg.frequencyCapPerSessionDay;
      capped.set(campaignId, over);
      return over;
    };

    const candidates: AuctionCandidate[] = [];
    for (const s of live) {
      const f = facts.get(s.productId);
      if (f === undefined || !f.purchasable || f.storeId !== s.campaign.storeId) continue;
      if (!matchesTargeting(s.campaign, f.categoryIds, input.ctx)) continue;
      if (await overCap(s.campaign.id)) continue;
      candidates.push({
        campaignId: s.campaign.id,
        storeId: s.campaign.storeId,
        productId: s.productId,
        bid: s.bid,
        maxCpc: s.campaign.maxCpc,
        bidAtMs: s.bidAtMs,
        relevanceBp: f.relevanceBp,
        sellerHealthBp: f.sellerHealthBp,
        priceTrustBp: f.priceTrustBp,
        remainingDaily: s.campaign.dailyBudget - s.spentToday,
        balance: s.balance,
      });
    }
    if (candidates.length === 0) return [];

    const { winners } = runAuction(candidates, { floorPrice: cfg.floorPrice, slots: cfg.slots, pricing: cfg.pricing });
    const queryHash = input.ctx.query === null ? null : sha256Hex(`ad-query:${input.ctx.query.normalize("NFKC").trim().toLowerCase()}`);
    const impressions: ImpressionRecord[] = [];
    const out: SponsoredSelection[] = [];
    for (const w of winners) {
      const impressionId = d.ids.uuidV7();
      impressions.push({
        id: impressionId,
        campaignId: w.campaignId,
        storeId: w.storeId,
        productId: w.productId,
        position: w.position,
        queryHash,
        sessionHash,
        atMs: nowMs,
      });
      out.push({
        campaignId: w.campaignId,
        productId: w.productId,
        storeId: w.storeId,
        position: w.position,
        impressionId,
        clickToken: await signClickToken(d, {
          jti: d.ids.uuidV7(),
          impressionId,
          campaignId: w.campaignId,
          productId: w.productId,
          sessionHash,
          price: w.price,
          issuedAtMs: nowMs,
        }),
        sponsored: true,
      });
    }
    await d.store.recordImpressions(impressions);
    return out;
  }
}
