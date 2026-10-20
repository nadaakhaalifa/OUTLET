import { BPS, type AuctionPricing } from "./types";

/**
 * Pure auction (spec 10 Rules). Option comparison:
 *  - first price: simple, but sellers shade bids and prices swing; rejected as default.
 *  - generalized second price (GSP): a winner pays just enough to keep its rank, so bidding the
 *    true value is a stable strategy; default.
 *  - fixed rate card: predictable but ignores demand and leaves revenue on the table.
 * Both GSP and first price are implemented so the property tests can assert GSP <= first price.
 *
 * Rank score = effective bid x quality, quality = relevance x seller health x price trust (each in
 * bps, multiplied exactly: no float, no precision loss). A winner pays
 * ceil(next.bid x next.quality / own.quality), clamped into [floor, own effective bid, own cap]
 * where cap = min(remaining daily budget, remaining prepaid balance).
 */
export interface AuctionCandidate {
  readonly campaignId: string;
  readonly storeId: string;
  readonly productId: string;
  /** Bid before the campaign max-CPC clamp. */
  readonly bid: bigint;
  readonly maxCpc: bigint;
  readonly bidAtMs: number;
  readonly relevanceBp: number;
  readonly sellerHealthBp: number;
  readonly priceTrustBp: number;
  /** Remaining daily budget of the campaign, piastres (may be <= 0). */
  readonly remainingDaily: bigint;
  /** Remaining prepaid balance of the store, piastres (may be <= 0). */
  readonly balance: bigint;
}

export type AuctionRejection =
  | "below_floor"
  | "budget_exhausted"
  | "no_balance"
  | "zero_quality"
  | "outbid_same_product"
  | "campaign_cap_reached";

export interface AuctionWinner {
  readonly campaignId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly position: number;
  readonly effectiveBid: bigint;
  /** What one valid click costs. Always <= effectiveBid and <= the campaign cap. */
  readonly price: bigint;
  readonly qualityBp: number;
}

export interface AuctionOutcome {
  readonly winners: readonly AuctionWinner[];
  readonly rejected: readonly { readonly campaignId: string; readonly productId: string; readonly reason: AuctionRejection }[];
}

const clampBp = (n: number): bigint => BigInt(Math.max(0, Math.min(10_000, Math.trunc(Number.isFinite(n) ? n : 0))));
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const ceilDiv = (n: bigint, d: bigint): bigint => (n + d - 1n) / d;

interface Ranked {
  readonly c: AuctionCandidate;
  readonly eff: bigint;
  readonly cap: bigint;
  readonly q: bigint;
  readonly score: bigint;
}

/** Score desc, then earliest bid, then campaign id, then product id: total and input-order independent. */
const byRank = (a: Ranked, b: Ranked): number => {
  if (a.score !== b.score) return a.score > b.score ? -1 : 1;
  if (a.c.bidAtMs !== b.c.bidAtMs) return a.c.bidAtMs - b.c.bidAtMs;
  if (a.c.campaignId !== b.c.campaignId) return a.c.campaignId < b.c.campaignId ? -1 : 1;
  if (a.c.productId !== b.c.productId) return a.c.productId < b.c.productId ? -1 : 1;
  return 0;
};

export function runAuction(
  candidates: readonly AuctionCandidate[],
  config: { readonly floorPrice: bigint; readonly slots: number; readonly pricing: AuctionPricing },
): AuctionOutcome {
  const rejected: { campaignId: string; productId: string; reason: AuctionRejection }[] = [];
  const reject = (c: AuctionCandidate, reason: AuctionRejection): void => {
    rejected.push({ campaignId: c.campaignId, productId: c.productId, reason });
  };
  const floor = config.floorPrice;

  const eligible: Ranked[] = [];
  for (const c of candidates) {
    const eff = min(c.bid, c.maxCpc);
    const q = clampBp(c.relevanceBp) * clampBp(c.sellerHealthBp) * clampBp(c.priceTrustBp);
    if (q === 0n) {
      reject(c, "zero_quality");
      continue;
    }
    if (eff < floor) {
      reject(c, "below_floor");
      continue;
    }
    if (c.remainingDaily < floor) {
      reject(c, "budget_exhausted");
      continue;
    }
    if (c.balance < floor) {
      reject(c, "no_balance");
      continue;
    }
    eligible.push({ c, eff, cap: min(c.remainingDaily, c.balance), q, score: eff * q });
  }

  // One entry per product: the best-ranked campaign (two campaigns, same SKU -> best bid).
  eligible.sort(byRank);
  const seen = new Set<string>();
  const ranked: Ranked[] = [];
  for (const r of eligible) {
    if (seen.has(r.c.productId)) {
      reject(r.c, "outbid_same_product");
      continue;
    }
    seen.add(r.c.productId);
    ranked.push(r);
  }

  const winners: AuctionWinner[] = [];
  const spentByCampaign = new Map<string, bigint>();
  const slots = Math.max(0, Math.trunc(config.slots));
  for (let i = 0; i < ranked.length && winners.length < slots; i += 1) {
    const r = ranked[i];
    if (r === undefined) continue;
    const used = spentByCampaign.get(r.c.campaignId) ?? 0n;
    const remainingCap = r.cap - used;
    if (remainingCap < floor) {
      reject(r.c, "campaign_cap_reached");
      continue;
    }
    const next = ranked[i + 1];
    let price: bigint;
    if (config.pricing === "first_price" || next === undefined) {
      price = config.pricing === "first_price" ? r.eff : floor;
    } else {
      price = ceilDiv(next.eff * next.q, r.q);
    }
    price = min(min(max(price, floor), r.eff), remainingCap);
    spentByCampaign.set(r.c.campaignId, used + price);
    winners.push({
      campaignId: r.c.campaignId,
      storeId: r.c.storeId,
      productId: r.c.productId,
      position: winners.length,
      effectiveBid: r.eff,
      price,
      qualityBp: Number(r.q / (BPS * BPS)),
    });
  }
  return { winners, rejected };
}
