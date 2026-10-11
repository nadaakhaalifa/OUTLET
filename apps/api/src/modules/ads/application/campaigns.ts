import {
  InvalidCampaignTransitionError,
  transitionCampaign,
  validateCampaignDraft,
  type Campaign,
  type CampaignEvent,
  type CampaignStatus,
  type FieldError,
} from "../domain/bridge";
import type { BidRecord, OutboxDraft } from "../domain/ports";
import { NEUTRAL_CONTEXT, configOf, type AdsDeps } from "./shared";

export interface CampaignInput {
  readonly storeId: string;
  readonly name: string;
  readonly dailyBudget: bigint;
  readonly maxCpc: bigint;
  readonly keywords: readonly string[];
  readonly categories: readonly string[];
  readonly startsAtMs: number;
  readonly endsAtMs: number | null;
  readonly bids: readonly { readonly productId: string; readonly bid: bigint }[];
}

export interface CampaignView extends Campaign {
  readonly bids: readonly { readonly productId: string; readonly bid: bigint }[];
}

export type CampaignResult =
  | { readonly kind: "ok"; readonly campaign: CampaignView }
  | { readonly kind: "invalid"; readonly errors: readonly FieldError[] }
  | { readonly kind: "advertising_blocked" }
  | { readonly kind: "product_not_owned" }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_transition" }
  | { readonly kind: "no_balance" };

const statusEvent = (c: Campaign, from: CampaignStatus, to: CampaignStatus, reason: string): OutboxDraft => ({
  type: "ad.campaign_status_changed",
  aggregateType: "ad_campaign",
  aggregateId: c.id,
  payload: { campaign_id: c.id, store_id: c.storeId, from, to, reason },
});

export async function viewOf(d: AdsDeps, c: Campaign): Promise<CampaignView> {
  const bids = await d.store.listBids(c.id);
  return { ...c, bids: bids.map((b) => ({ productId: b.productId, bid: b.bid })) };
}

/** Every product must belong to the advertiser's store. Unknown and foreign are indistinguishable. */
async function ownsAll(d: AdsDeps, storeId: string, productIds: readonly string[]): Promise<boolean> {
  const facts = await d.eligibility.facts(productIds, NEUTRAL_CONTEXT);
  const byId = new Map(facts.map((f) => [f.productId, f.storeId]));
  return productIds.every((p) => byId.get(p) === storeId);
}

export class CreateCampaign {
  constructor(private readonly d: AdsDeps) {}

  async execute(i: CampaignInput): Promise<CampaignResult> {
    const d = this.d;
    const nowMs = d.clock.nowMs();
    const cfg = await configOf(d);
    if ((await d.enforcement.blockedStores([i.storeId])).has(i.storeId)) return { kind: "advertising_blocked" };
    const v = validateCampaignDraft(i, cfg, nowMs);
    if (!v.ok) return { kind: "invalid", errors: v.errors };
    if (!(await ownsAll(d, i.storeId, v.value.bids.map((b) => b.productId)))) return { kind: "product_not_owned" };
    const balance = await d.store.getBalance(i.storeId);
    const campaign: Campaign = {
      id: d.ids.uuidV7(),
      storeId: i.storeId,
      name: v.value.name,
      status: balance >= cfg.floorPrice ? "ACTIVE" : "PAUSED_NO_BALANCE",
      dailyBudget: v.value.dailyBudget,
      maxCpc: v.value.maxCpc,
      keywords: v.value.keywords,
      categories: v.value.categories,
      startsAtMs: i.startsAtMs,
      endsAtMs: i.endsAtMs,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    const bids: BidRecord[] = v.value.bids.map((b) => ({ campaignId: campaign.id, productId: b.productId, bid: b.bid, createdAtMs: nowMs }));
    await d.store.insertCampaign(campaign, bids);
    return { kind: "ok", campaign: await viewOf(d, campaign) };
  }
}

export interface CampaignUpdate {
  readonly campaignId: string;
  readonly name?: string;
  readonly dailyBudget?: bigint;
  readonly maxCpc?: bigint;
  readonly keywords?: readonly string[];
  readonly categories?: readonly string[];
  readonly endsAtMs?: number | null;
  readonly bids?: readonly { readonly productId: string; readonly bid: bigint }[];
}

export class UpdateCampaign {
  constructor(private readonly d: AdsDeps) {}

  async execute(u: CampaignUpdate): Promise<CampaignResult> {
    const d = this.d;
    const current = await d.store.getCampaign(u.campaignId);
    if (current === null) return { kind: "not_found" };
    if (current.status === "ENDED") return { kind: "invalid_transition" };
    const nowMs = d.clock.nowMs();
    const cfg = await configOf(d);
    const existing = await d.store.listBids(current.id);
    const draft = {
      name: u.name ?? current.name,
      dailyBudget: u.dailyBudget ?? current.dailyBudget,
      maxCpc: u.maxCpc ?? current.maxCpc,
      keywords: u.keywords ?? current.keywords,
      categories: u.categories ?? current.categories,
      startsAtMs: current.startsAtMs,
      endsAtMs: u.endsAtMs === undefined ? current.endsAtMs : u.endsAtMs,
      bids: u.bids ?? existing.map((b) => ({ productId: b.productId, bid: b.bid })),
    };
    const v = validateCampaignDraft(draft, cfg, nowMs);
    if (!v.ok) return { kind: "invalid", errors: v.errors };
    if (u.bids !== undefined && !(await ownsAll(d, current.storeId, v.value.bids.map((b) => b.productId)))) {
      return { kind: "product_not_owned" };
    }
    const bids: BidRecord[] | null =
      u.bids === undefined ? null : v.value.bids.map((b) => ({ campaignId: current.id, productId: b.productId, bid: b.bid, createdAtMs: nowMs }));
    const updated = await d.store.updateCampaign(
      current.id,
      {
        name: v.value.name,
        dailyBudget: v.value.dailyBudget,
        maxCpc: v.value.maxCpc,
        keywords: v.value.keywords,
        categories: v.value.categories,
        endsAtMs: v.value.endsAtMs,
      },
      bids,
      nowMs,
    );
    return updated === null ? { kind: "not_found" } : { kind: "ok", campaign: await viewOf(d, updated) };
  }
}

/** Seller pause and resume. Resume needs a funded balance and an advertiser in good standing. */
export class ChangeCampaignStatus {
  constructor(private readonly d: AdsDeps) {}

  async execute(input: { readonly campaignId: string; readonly event: "seller_pause" | "seller_resume" }): Promise<CampaignResult> {
    const d = this.d;
    const c = await d.store.getCampaign(input.campaignId);
    if (c === null) return { kind: "not_found" };
    let to: CampaignStatus;
    try {
      to = transitionCampaign(c.status, input.event satisfies CampaignEvent);
    } catch (e) {
      if (e instanceof InvalidCampaignTransitionError) return { kind: "invalid_transition" };
      throw e;
    }
    if (input.event === "seller_resume") {
      if ((await d.enforcement.blockedStores([c.storeId])).has(c.storeId)) return { kind: "advertising_blocked" };
      const cfg = await configOf(d);
      if ((await d.store.getBalance(c.storeId)) < cfg.floorPrice) return { kind: "no_balance" };
    }
    const nowMs = d.clock.nowMs();
    const next = await d.store.setStatus(c.id, c.status, to, nowMs, [statusEvent(c, c.status, to, input.event)]);
    return next === null ? { kind: "invalid_transition" } : { kind: "ok", campaign: await viewOf(d, next) };
  }
}

export class GetCampaign {
  constructor(private readonly d: AdsDeps) {}
  async execute(id: string): Promise<CampaignView | null> {
    const c = await this.d.store.getCampaign(id);
    return c === null ? null : viewOf(this.d, c);
  }
}

export class ListCampaigns {
  constructor(private readonly d: AdsDeps) {}
  async execute(storeId: string, limit = 50): Promise<readonly CampaignView[]> {
    const cs = await this.d.store.listCampaigns(storeId, limit);
    return Promise.all(cs.map((c) => viewOf(this.d, c)));
  }
}

/** System: price enforcement changed for a store. Suspends or releases its campaigns. */
export class ApplyEnforcement {
  constructor(private readonly d: AdsDeps) {}

  async execute(input: { readonly storeId: string; readonly blocked: boolean }): Promise<number> {
    const d = this.d;
    const nowMs = d.clock.nowMs();
    let n = 0;
    if (input.blocked) {
      for (const status of ["ACTIVE", "PAUSED", "PAUSED_NO_BALANCE"] as const) {
        for (const c of await d.store.listStoreCampaignsInStatus(input.storeId, status)) {
          const r = await d.store.setStatus(c.id, status, "SUSPENDED", nowMs, [statusEvent(c, status, "SUSPENDED", "enforcement_suspend")]);
          if (r !== null) n += 1;
        }
      }
      return n;
    }
    for (const c of await d.store.listStoreCampaignsInStatus(input.storeId, "SUSPENDED")) {
      const r = await d.store.setStatus(c.id, "SUSPENDED", "PAUSED", nowMs, [statusEvent(c, "SUSPENDED", "PAUSED", "enforcement_lifted")]);
      if (r !== null) n += 1;
    }
    return n;
  }
}

/** Sweeper: campaigns past their end date become ENDED. Idempotent. */
export class EndExpiredCampaigns {
  constructor(private readonly d: AdsDeps) {}

  async execute(limit = 200): Promise<number> {
    const d = this.d;
    const nowMs = d.clock.nowMs();
    let n = 0;
    for (const status of ["ACTIVE", "PAUSED", "PAUSED_NO_BALANCE", "SUSPENDED"] as const) {
      for (const c of await d.store.listByStatus(status, limit)) {
        if (c.endsAtMs === null || c.endsAtMs > nowMs) continue;
        if ((await d.store.setStatus(c.id, status, "ENDED", nowMs, [statusEvent(c, status, "ENDED", "end")])) !== null) n += 1;
      }
    }
    return n;
  }
}

export { statusEvent };
