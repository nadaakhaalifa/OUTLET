import {
  attributionWindowEnd,
  canEarn,
  classifyClick,
  decideCreatorFraud,
  rateTable,
  selectLastClick,
  type IneligibleReason,
  type LinkTargetType,
  type UaClass,
} from "../domain/bridge";
import type {
  AffiliateLink,
  Attribution,
  AttributionVoidReason,
  Clock,
  CreatorAccount,
  CreatorCatalogPort,
  CreatorEvent,
  CreatorFlagsPort,
  CreatorIdentityPort,
  CreatorReferralPort,
  CreatorLook,
  CreatorStore,
  IdPort,
  TokenEntropy,
} from "../domain/ports";
import { creatorFacts } from "./accounts";
import type { PostCommissionIntents } from "./commissions";
import { CLICK_PARTITIONS_AHEAD, CLICK_RETAIN_MONTHS, HOUR_MS, MINUTE_MS, slugFromBytes, type CreatorRuntimeOptions } from "./shared";

// ---- links ---------------------------------------------------------------------------------------

export type CreateLinkResult =
  | { readonly kind: "created" | "exists"; readonly link: AffiliateLink }
  | { readonly kind: "no_account" }
  | { readonly kind: "not_eligible"; readonly reason: IneligibleReason }
  | { readonly kind: "target_not_found" }
  | { readonly kind: "seller_conflict" }
  | { readonly kind: "unavailable" };

export class CreateLink {
  constructor(
    private readonly store: CreatorStore,
    private readonly identity: CreatorIdentityPort,
    private readonly catalog: CreatorCatalogPort,
    private readonly flags: CreatorFlagsPort,
    private readonly clock: Clock,
    private readonly ids: IdPort,
    private readonly entropy: TokenEntropy,
    private readonly opts: CreatorRuntimeOptions,
  ) {}

  async execute(userId: string, targetType: LinkTargetType, targetId: string): Promise<CreateLinkResult> {
    if (!(await this.flags.programEnabled())) return { kind: "unavailable" };
    const a = await this.store.getByUser(userId);
    if (a === null) return { kind: "no_account" };
    const reason = canEarn(this.opts.config, await creatorFacts(this.identity, a));
    if (reason !== null) return { kind: "not_eligible", reason };

    // A look target must be the creator's own published look.
    if (targetType === "look") {
      const look = await this.store.getLook(targetId);
      if (look === null || look.creatorId !== a.id || look.status !== "PUBLISHED") return { kind: "target_not_found" };
    } else {
      const t = await this.catalog.resolveTarget(targetType, targetId);
      if (!t.exists) return { kind: "target_not_found" };
      const p = await this.identity.profile(userId);
      if (t.storeId !== null && (p?.sellerStoreIds ?? []).includes(t.storeId)) return { kind: "seller_conflict" };
    }

    for (let i = 0; i < 5; i += 1) {
      const link: AffiliateLink = {
        id: this.ids.uuidV7(),
        creatorId: a.id,
        targetType,
        targetId,
        slug: slugFromBytes(this.entropy.randomBytes(16)),
        status: "ACTIVE",
        createdAtMs: this.clock.nowMs(),
      };
      const r = await this.store.insertLink(link, [{ type: "affiliate.link_created", creatorId: a.id, linkId: link.id }]);
      if (r.kind === "created" || r.kind === "exists") return r;
    }
    return { kind: "unavailable" };
  }
}

export class ListLinks {
  constructor(private readonly store: CreatorStore) {}
  async execute(userId: string): Promise<readonly AffiliateLink[] | null> {
    const a = await this.store.getByUser(userId);
    return a === null ? null : this.store.listLinks(a.id);
  }
}

export class DisableLink {
  constructor(
    private readonly store: CreatorStore,
    private readonly clock: Clock,
  ) {}
  /** Another creator's link id is indistinguishable from a missing one. */
  async execute(userId: string, linkId: string): Promise<boolean> {
    const a = await this.store.getByUser(userId);
    if (a === null) return false;
    return this.store.disableLink(a.id, linkId, this.clock.nowMs());
  }
}

// ---- clicks ---------------------------------------------------------------------------------------

export interface ClickInput {
  readonly slug: string;
  /** SHA-256 hex. */
  readonly deviceHash: string;
  readonly ipHash: string;
  readonly uaClass: UaClass;
}

export type ClickResult =
  | { readonly kind: "recorded"; readonly targetType: LinkTargetType; readonly targetId: string }
  | { readonly kind: "unknown" };

export class RecordClick {
  constructor(
    private readonly store: CreatorStore,
    private readonly flags: CreatorFlagsPort,
    private readonly clock: Clock,
    private readonly ids: IdPort,
    private readonly opts: CreatorRuntimeOptions,
  ) {}

  /**
   * Public. Unknown, disabled, suspended-creator and kill-switched links all answer "unknown", so
   * the route is not a way to enumerate creators. Bots are recorded (analytics) but never attribute.
   */
  async execute(input: ClickInput): Promise<ClickResult> {
    if (!(await this.flags.programEnabled())) return { kind: "unknown" };
    const link = await this.store.findLinkBySlug(input.slug);
    if (link === null || link.status !== "ACTIVE") return { kind: "unknown" };
    const creator = await this.store.getById(link.creatorId);
    if (creator === null || creator.status !== "ACTIVE") return { kind: "unknown" };

    const nowMs = this.clock.nowMs();
    const cfg = this.opts.config;
    const minuteStart = nowMs - (nowMs % MINUTE_MS);
    const counts = await this.store.clickCountsSince({
      creatorId: creator.id,
      linkId: link.id,
      ipHash: input.ipHash,
      deviceHash: input.deviceHash,
      hourSinceMs: nowMs - HOUR_MS,
      dedupeSinceMs: nowMs - cfg.clickDedupeWindowMs,
      minuteSinceMs: minuteStart,
    });
    // Dedupe: the same device on the same link inside the window stores nothing new.
    if (counts.duplicate) return { kind: "recorded", targetType: link.targetType, targetId: link.targetId };
    const c = classifyClick(cfg, {
      uaClass: input.uaClass,
      countedForIpThisHour: counts.ip,
      countedForDeviceThisHour: counts.device,
      countedForLinkThisHour: counts.link,
    });
    // One aggregate outbox event per creator per minute, never one per click (A-1).
    const events: CreatorEvent[] =
      counts.creatorThisMinute === 0 ? [{ type: "affiliate.clicks_active", creatorId: creator.id, minuteMs: minuteStart }] : [];
    await this.store.insertClick(
      {
        id: this.ids.uuidV7(),
        linkId: link.id,
        creatorId: creator.id,
        atMs: nowMs,
        deviceHash: input.deviceHash,
        ipHash: input.ipHash,
        counted: c.counted,
        uaClass: input.uaClass,
      },
      events,
    );
    return { kind: "recorded", targetType: link.targetType, targetId: link.targetId };
  }
}

// ---- attribution (called by checkout after payment) -----------------------------------------------

export type AttributeOrderResult =
  | { readonly kind: "none" }
  | { readonly kind: "existing"; readonly attribution: Attribution }
  | { readonly kind: "attributed"; readonly attribution: Attribution }
  /** Voided silently. The caller must treat it exactly like "none". */
  | { readonly kind: "voided" }
  /**
   * Fail closed (A-3): the fraud gate could not run. Nothing accrues; the attribution is stored as
   * HELD and re-evaluated on the next call. The caller treats it like "none" and may retry later.
   */
  | { readonly kind: "held" };

const MAX_SIBLINGS = 50;

export class AttributeOrder {
  constructor(
    private readonly store: CreatorStore,
    private readonly identity: CreatorIdentityPort,
    private readonly flags: CreatorFlagsPort,
    private readonly clock: Clock,
    private readonly opts: CreatorRuntimeOptions,
    private readonly referrals?: CreatorReferralPort,
  ) {}

  async execute(input: { readonly orderGroupId: string; readonly buyerUserId: string; readonly orderAtMs: number }): Promise<AttributeOrderResult> {
    const prior = await this.store.getAttribution(input.orderGroupId);
    if (prior !== null && prior.status === "ACTIVE") return { kind: "existing", attribution: prior };
    if (prior !== null && prior.status === "VOIDED") return { kind: "voided" };
    if (!(await this.flags.programEnabled())) return prior !== null ? { kind: "held" } : { kind: "none" };

    const cfg = this.opts.config;
    const buyer = await this.identity.profile(input.buyerUserId);
    if (buyer === null || buyer.deviceHashes.length === 0) return { kind: "none" };
    const clicks = await this.store.clicksForDevices(buyer.deviceHashes, input.orderAtMs - cfg.attributionWindowMs, input.orderAtMs);
    if (clicks.length === 0) return { kind: "none" };

    const active = new Set<string>();
    for (const id of new Set(clicks.map((c) => c.creatorId))) {
      const a = await this.store.getById(id);
      if (a !== null && a.status === "ACTIVE") active.add(id);
    }
    const click = selectLastClick(cfg, {
      orderAtMs: input.orderAtMs,
      buyerDeviceHashes: buyer.deviceHashes,
      clicks,
      activeCreatorIds: active,
      sessionStartedAtMs: buyer.sessionStartedAtMs ?? null,
    });
    if (click === null) return { kind: "none" };

    const creator = await this.store.getById(click.creatorId);
    if (creator === null) return { kind: "none" };
    const creatorProfile = await this.identity.profile(creator.userId);
    const nowMs = this.clock.nowMs();
    const heldBase = {
      orderGroupId: input.orderGroupId,
      creatorId: creator.id,
      linkId: click.linkId,
      clickId: click.id,
      clickAtMs: click.atMs,
      buyerUserId: input.buyerUserId,
      rateSnapshot: {
        defaultBps: Number(rateTable(cfg, null)),
        categoryBps: Object.fromEntries(Object.entries(cfg.categoryRateBps).map(([k, v]) => [k, Number(v)])),
      },
      windowEndMs: attributionWindowEnd(cfg, click.atMs),
      voidReason: null,
      createdAtMs: prior?.createdAtMs ?? nowMs,
    } as const;
    if (creatorProfile === null) {
      if (prior === null) {
        await this.store.insertAttribution({ ...heldBase, status: "HELD", holdReason: "identity_unavailable" }, [
          { type: "creator.attribution_held", creatorId: creator.id, orderGroupId: input.orderGroupId, reason: "identity_unavailable" },
        ]);
      }
      return { kind: "held" };
    }
    const siblingIds = await this.store.attributedBuyers(creator.id, MAX_SIBLINGS);
    const siblings = [];
    for (const uid of siblingIds) {
      const p = await this.identity.profile(uid);
      if (p !== null) siblings.push(p);
    }
    const fraud = decideCreatorFraud({
      creator: creatorProfile,
      buyer,
      otherBuyers: siblings,
      clusterThreshold: cfg.clusterThreshold,
    });
    const base: Attribution = { ...heldBase, status: "ACTIVE", holdReason: null };
    // A-4: one reward per order. A referral reward on the order wins; the commission is voided silently.
    let stacking = false;
    if (fraud === null && this.referrals !== undefined) {
      try {
        stacking = await this.referrals.rewardAppliesTo({ orderGroupId: input.orderGroupId, buyerUserId: input.buyerUserId });
      } catch {
        // Fail closed: cannot tell, so do not attribute yet (held, retried on the next call).
        if (prior === null) {
          await this.store.insertAttribution({ ...heldBase, status: "HELD", holdReason: "identity_unavailable" }, [
            { type: "creator.attribution_held", creatorId: creator.id, orderGroupId: input.orderGroupId, reason: "referral_check_unavailable" },
          ]);
        }
        return { kind: "held" };
      }
    }
    const voidWhy: AttributionVoidReason | null = fraud ?? (stacking ? "referral_stacking" : null);
    if (voidWhy !== null) {
      // Silent: stored and evented for the review queue, never surfaced to creator or buyer.
      const voided: Attribution = { ...base, status: "VOIDED", voidReason: voidWhy };
      const events: CreatorEvent[] = [
        { type: "creator.attribution_voided", creatorId: creator.id, orderGroupId: input.orderGroupId, reason: voidWhy },
      ];
      if (prior !== null) await this.store.resolveHeldAttribution(voided, events);
      else await this.store.insertAttribution(voided, events);
      return { kind: "voided" };
    }
    const okEvents: CreatorEvent[] = [{ type: "creator.order_attributed", creatorId: creator.id, orderGroupId: input.orderGroupId }];
    if (prior !== null) {
      if (!(await this.store.resolveHeldAttribution(base, okEvents))) {
        const again = await this.store.getAttribution(input.orderGroupId);
        return again !== null && again.status === "ACTIVE" ? { kind: "existing", attribution: again } : { kind: "voided" };
      }
      return { kind: "attributed", attribution: base };
    }
    const r = await this.store.insertAttribution(base, okEvents);
    if (r === "exists") {
      const again = await this.store.getAttribution(input.orderGroupId);
      return again !== null && again.status === "ACTIVE" ? { kind: "existing", attribution: again } : { kind: "voided" };
    }
    return { kind: "attributed", attribution: base };
  }
}

// ---- looks ----------------------------------------------------------------------------------------

export type LookResult =
  | { readonly kind: "ok"; readonly look: CreatorLook }
  | { readonly kind: "not_found" }
  | { readonly kind: "no_account" }
  | { readonly kind: "not_eligible"; readonly reason: IneligibleReason }
  | { readonly kind: "unknown_products"; readonly productIds: readonly string[] }
  | { readonly kind: "invalid_state" }
  | { readonly kind: "unavailable" };

const MAX_LOOK_ITEMS = 12;

export class LookCommands {
  constructor(
    private readonly store: CreatorStore,
    private readonly identity: CreatorIdentityPort,
    private readonly catalog: CreatorCatalogPort,
    private readonly flags: CreatorFlagsPort,
    private readonly clock: Clock,
    private readonly ids: IdPort,
    private readonly opts: CreatorRuntimeOptions,
  ) {}

  private async owner(userId: string): Promise<{ a: CreatorAccount } | LookResult> {
    const a = await this.store.getByUser(userId);
    if (a === null) return { kind: "no_account" };
    const reason = canEarn(this.opts.config, await creatorFacts(this.identity, a));
    if (reason !== null) return { kind: "not_eligible", reason };
    return { a };
  }

  private async validateProducts(ids: readonly string[]): Promise<readonly string[]> {
    const ok = await this.catalog.existingProducts(ids);
    return ids.filter((i) => !ok.has(i));
  }

  async create(userId: string, input: { title: string; productIds: readonly string[] }): Promise<LookResult> {
    if (!(await this.flags.programEnabled())) return { kind: "unavailable" };
    const o = await this.owner(userId);
    if (!("a" in o)) return o;
    const ids = [...new Set(input.productIds)].slice(0, MAX_LOOK_ITEMS);
    const missing = await this.validateProducts(ids);
    if (missing.length > 0) return { kind: "unknown_products", productIds: missing };
    const nowMs = this.clock.nowMs();
    const look: CreatorLook = {
      id: this.ids.uuidV7(),
      creatorId: o.a.id,
      title: input.title.trim(),
      status: "DRAFT",
      takedownReason: null,
      productIds: ids,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    await this.store.insertLook(look);
    return { kind: "ok", look };
  }

  async update(userId: string, lookId: string, input: { title?: string; productIds?: readonly string[] }): Promise<LookResult> {
    const o = await this.owner(userId);
    if (!("a" in o)) return o;
    const look = await this.store.getLook(lookId);
    if (look === null || look.creatorId !== o.a.id) return { kind: "not_found" };
    if (look.status === "TAKEN_DOWN" || look.status === "ARCHIVED") return { kind: "invalid_state" };
    let productIds = look.productIds;
    if (input.productIds !== undefined) {
      const ids = [...new Set(input.productIds)].slice(0, MAX_LOOK_ITEMS);
      const missing = await this.validateProducts(ids);
      if (missing.length > 0) return { kind: "unknown_products", productIds: missing };
      productIds = ids;
    }
    const next: CreatorLook = { ...look, title: input.title?.trim() ?? look.title, productIds, updatedAtMs: this.clock.nowMs() };
    await this.store.updateLook(next);
    return { kind: "ok", look: next };
  }

  async publish(userId: string, lookId: string): Promise<LookResult> {
    const o = await this.owner(userId);
    if (!("a" in o)) return o;
    const look = await this.store.getLook(lookId);
    if (look === null || look.creatorId !== o.a.id) return { kind: "not_found" };
    if (look.status !== "DRAFT") return { kind: "invalid_state" };
    if (look.productIds.length === 0) return { kind: "invalid_state" };
    const missing = await this.validateProducts(look.productIds);
    if (missing.length > 0) return { kind: "unknown_products", productIds: missing };
    const next: CreatorLook = { ...look, status: "PUBLISHED", updatedAtMs: this.clock.nowMs() };
    await this.store.updateLook(next);
    return { kind: "ok", look: next };
  }

  async archive(userId: string, lookId: string): Promise<LookResult> {
    const a = await this.store.getByUser(userId);
    if (a === null) return { kind: "no_account" };
    const look = await this.store.getLook(lookId);
    if (look === null || look.creatorId !== a.id) return { kind: "not_found" };
    if (look.status === "TAKEN_DOWN") return { kind: "invalid_state" };
    const next: CreatorLook = { ...look, status: "ARCHIVED", updatedAtMs: this.clock.nowMs() };
    await this.store.updateLook(next);
    return { kind: "ok", look: next };
  }

  /** Trust and safety takedown (§27). Admin only; the creator cannot undo it. */
  async takedown(lookId: string, reason: string): Promise<LookResult> {
    const look = await this.store.getLook(lookId);
    if (look === null) return { kind: "not_found" };
    const next: CreatorLook = { ...look, status: "TAKEN_DOWN", takedownReason: reason, updatedAtMs: this.clock.nowMs() };
    await this.store.updateLook(next);
    return { kind: "ok", look: next };
  }

  async list(userId: string): Promise<readonly CreatorLook[] | null> {
    const a = await this.store.getByUser(userId);
    return a === null ? null : this.store.listLooks(a.id);
  }
}

// ---- public profile -------------------------------------------------------------------------------

export interface PublicCreatorView {
  readonly handle: string;
  readonly displayName: string;
  readonly looks: readonly { readonly id: string; readonly title: string; readonly productIds: readonly string[] }[];
}

export class GetPublicCreator {
  constructor(private readonly store: CreatorStore) {}
  /** Active creators only; no ids of the account, no PII. */
  async execute(handle: string): Promise<PublicCreatorView | null> {
    const a = await this.store.getByHandle(handle);
    if (a === null || a.status !== "ACTIVE") return null;
    const looks = (await this.store.listLooks(a.id)).filter((l) => l.status === "PUBLISHED");
    return {
      handle: a.handle,
      displayName: a.displayName,
      looks: looks.map((l) => ({ id: l.id, title: l.title, productIds: l.productIds })),
    };
  }
}

// ---- void after the fact (A-3) --------------------------------------------------------------------

export type VoidAttributionResult =
  | { readonly kind: "not_found" | "already_voided" }
  | { readonly kind: "voided"; readonly commissionsAffected: number; readonly clawedBack: bigint };

/**
 * Trust and safety found a ring after accrual (or after payout). Voids the attribution and, in one
 * store transaction, plans the full clawback of every commission of the order group; the poster
 * then posts the idempotent reversing entries. A paid commission leaves an explicit negative
 * payable (never silent), netted from the creator's next accrual.
 */
export class VoidAttribution {
  constructor(
    private readonly store: CreatorStore,
    private readonly poster: PostCommissionIntents,
  ) {}

  async execute(input: { readonly orderGroupId: string; readonly reason: AttributionVoidReason }): Promise<VoidAttributionResult> {
    const a = await this.store.getAttribution(input.orderGroupId);
    if (a === null) return { kind: "not_found" };
    const r = await this.store.voidOrderGroup({
      orderGroupId: input.orderGroupId,
      reason: input.reason,
      events: [{ type: "creator.attribution_voided", creatorId: a.creatorId, orderGroupId: input.orderGroupId, reason: input.reason }],
    });
    if (r.kind !== "voided") return r;
    for (const id of r.commissionIds) await this.poster.forCommission(id);
    return { kind: "voided", commissionsAffected: r.commissionIds.length, clawedBack: r.clawedBack };
  }
}

// ---- click partitions and retention (A-9) ----------------------------------------------------------

export class MaintainClickPartitions {
  constructor(
    private readonly store: CreatorStore,
    private readonly clock: Clock,
  ) {}
  /** Creates upcoming monthly partitions and enforces the 13 month retention. Idempotent. */
  async execute(): Promise<{ readonly created: number; readonly dropped: number; readonly deletedRows: number }> {
    return this.store.maintainClickPartitions({
      nowMs: this.clock.nowMs(),
      monthsAhead: CLICK_PARTITIONS_AHEAD,
      retainMonths: CLICK_RETAIN_MONTHS,
    });
  }
}
