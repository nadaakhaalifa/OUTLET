import { promotions, type Money } from "../domain/bridge";
import type {
  LocalizedText,
  OwnerFilter,
  PromotionEventPublisher,
  PromotionPatch,
  PromotionRecord,
  PromotionRepository,
  RedemptionOutcome,
} from "../domain/ports";
import { PromotionsUnavailableError } from "../domain/ports";

export interface Clock {
  nowMs(): number;
}
export interface IdGenerator {
  uuidV7(): string;
}

export interface PromotionDeps {
  readonly repo: PromotionRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly events: PromotionEventPublisher;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PromotionsUnavailableError) throw e;
    // Any persistence failure is "unavailable": checkout proceeds without discounts, never guesses.
    throw new PromotionsUnavailableError();
  }
}

// ---- evaluate (internal) ----------------------------------------------------------------

export interface EvaluateInput {
  readonly userId: string;
  readonly lines: readonly promotions.EvalLine[];
  readonly shippingFees: readonly promotions.ShippingFee[];
  readonly codes: readonly string[];
  readonly paymentMethod: promotions.PaymentMethod | null;
  readonly isPlus: boolean;
  readonly atMs: number;
}

export class EvaluatePromotions {
  constructor(private readonly deps: PromotionDeps) {}

  async execute(input: EvaluateInput): Promise<promotions.EvaluationResult> {
    const storeIds = [...new Set(input.lines.map((l) => l.storeId))];
    const codes = [...new Set(input.codes.map(promotions.normalizeCode).filter((c) => c !== ""))].slice(0, 5);
    const pool = await guard(() => this.deps.repo.candidates({ atMs: input.atMs, storeIds, codes }));
    const usage =
      pool.length === 0
        ? new Map<string, promotions.Usage>()
        : await guard(() =>
            this.deps.repo.usage(
              pool.map((p) => p.id),
              input.userId,
              promotions.cairoDayKey(input.atMs),
            ),
          );
    return promotions.evaluatePromotions(
      {
        userId: input.userId,
        lines: input.lines,
        shippingFees: input.shippingFees,
        codes,
        paymentMethod: input.paymentMethod,
        isPlus: input.isPlus,
        atMs: input.atMs,
        usage,
      },
      pool,
    );
  }
}

// ---- create ------------------------------------------------------------------------------

export interface CreateInput {
  readonly owner: OwnerFilter;
  readonly createdBy: string;
  readonly title: LocalizedText;
  readonly kind: promotions.PromotionKind;
  readonly scope: promotions.PromotionScope;
  readonly value: promotions.PromotionValue;
  readonly code: string | null;
  readonly autoApply: boolean;
  readonly funding: promotions.Funding;
  readonly targeting: promotions.Targeting;
  readonly minOrder: Money | null;
  readonly maxDiscount: Money | null;
  readonly perUserCap: number | null;
  readonly perDayCap: number | null;
  readonly totalBudget: Money | null;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
}

export type CreateResult =
  | { readonly kind: "ok"; readonly record: PromotionRecord }
  | { readonly kind: "invalid"; readonly issues: readonly string[] }
  | { readonly kind: "code_taken" };

export class CreatePromotion {
  constructor(private readonly deps: PromotionDeps) {}

  async execute(input: CreateInput): Promise<CreateResult> {
    const now = this.deps.clock.nowMs();
    const targeting: promotions.Targeting =
      input.owner.kind === "store" && input.targeting.storeIds.length === 0
        ? { ...input.targeting, storeIds: [input.owner.storeId] }
        : input.targeting;
    const record: PromotionRecord = {
      id: this.deps.ids.uuidV7(),
      version: 1,
      owner: input.owner.kind === "store" ? { kind: "store", storeId: input.owner.storeId } : { kind: "platform" },
      scope: input.scope,
      value: input.value,
      code: input.code === null ? null : promotions.normalizeCode(input.code),
      autoApply: input.autoApply,
      funding: input.funding,
      targeting,
      minOrder: input.minOrder,
      maxDiscount: input.maxDiscount,
      perUserCap: input.perUserCap,
      perDayCap: input.perDayCap,
      totalBudget: input.totalBudget,
      startsAtMs: input.startsAtMs,
      endsAtMs: input.endsAtMs,
      // New promotions are drafts; activation is an explicit, audited edit.
      status: "draft",
      title: input.title,
      createdBy: input.createdBy,
      createdAtMs: now,
      updatedAtMs: now,
    };
    const issues = promotions.validatePromotion(record);
    if (issues.length > 0) return { kind: "invalid", issues };
    const r = await guard(() => this.deps.repo.insert(record));
    return r === "created" ? { kind: "ok", record } : { kind: "code_taken" };
  }
}

// ---- read / list -------------------------------------------------------------------------

const matchesOwner = (p: PromotionRecord, owner: OwnerFilter): boolean =>
  owner.kind === "platform" ? p.owner.kind === "platform" : p.owner.kind === "store" && p.owner.storeId === owner.storeId;

export class GetPromotion {
  constructor(private readonly deps: PromotionDeps) {}
  /** Null both when missing and when the promotion belongs to another owner (no existence oracle). */
  async execute(id: string, owner: OwnerFilter): Promise<PromotionRecord | null> {
    const p = await guard(() => this.deps.repo.get(id));
    return p !== null && matchesOwner(p, owner) ? p : null;
  }
}

export class ListPromotions {
  constructor(private readonly deps: PromotionDeps) {}
  async execute(input: {
    readonly owner: OwnerFilter;
    readonly afterId: string | null;
    readonly limit: number;
  }): Promise<{ readonly items: readonly PromotionRecord[]; readonly hasMore: boolean }> {
    const rows = await guard(() =>
      this.deps.repo.list({ owner: input.owner, afterId: input.afterId, limit: input.limit + 1 }),
    );
    return { items: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
  }
}

// ---- update / end ------------------------------------------------------------------------

export type UpdateResult =
  | { readonly kind: "ok"; readonly record: PromotionRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "stale" }
  | { readonly kind: "invalid"; readonly issues: readonly string[] };

const TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  draft: ["active", "ended"],
  scheduled: ["active", "paused", "ended"],
  active: ["paused", "ended"],
  paused: ["active", "ended"],
  ended: [],
};

export class UpdatePromotion {
  constructor(private readonly deps: PromotionDeps) {}

  async execute(input: {
    readonly id: string;
    readonly owner: OwnerFilter;
    readonly expectedVersion: number;
    readonly patch: PromotionPatch;
  }): Promise<UpdateResult> {
    const current = await guard(() => this.deps.repo.get(input.id));
    if (current === null || !matchesOwner(current, input.owner)) return { kind: "not_found" };
    const issues: string[] = [];
    const patch = input.patch;
    if (patch.status !== undefined && patch.status !== current.status && !TRANSITIONS[current.status]?.includes(patch.status)) {
      issues.push("status_transition_not_allowed");
    }
    if (current.status === "ended" && patch.status === undefined) issues.push("promotion_ended");
    if (patch.endsAtMs !== undefined && patch.endsAtMs <= current.startsAtMs) issues.push("window_invalid");
    for (const [name, m] of [
      ["max_discount", patch.maxDiscount],
      ["total_budget", patch.totalBudget],
    ] as const) {
      if (m !== undefined && (m.amount <= 0n || m.currency !== "EGP")) issues.push(`${name}_invalid`);
    }
    if (issues.length > 0) return { kind: "invalid", issues };
    const now = this.deps.clock.nowMs();
    const r = await guard(() => this.deps.repo.update(input.id, input.expectedVersion, patch, now));
    if (r === null) return { kind: "not_found" };
    if (r === "stale") return { kind: "stale" };
    if (patch.status === "active" && current.status !== "active") {
      await this.deps.events.publish({ name: "promotion.activated", promotionId: r.id, orderGroupId: null, atMs: now });
    }
    if (patch.status === "ended" && current.status !== "ended") {
      await this.deps.events.publish({ name: "promotion.ended", promotionId: r.id, orderGroupId: null, atMs: now });
    }
    return { kind: "ok", record: r };
  }
}

// ---- redemptions (checkout commit path) ---------------------------------------------------

export class RecordRedemptions {
  constructor(private readonly deps: PromotionDeps) {}

  /** Commits the discount allocations of an evaluation against caps and budget, idempotently per order group. */
  async execute(input: {
    readonly userId: string;
    readonly orderGroupId: string;
    readonly applied: readonly promotions.AppliedPromotion[];
  }): Promise<RedemptionOutcome> {
    const atMs = this.deps.clock.nowMs();
    const dayKey = promotions.cairoDayKey(atMs);
    const out = await guard(() =>
      this.deps.repo.recordRedemptions(
        input.applied.map((a) => ({
          promotionId: a.promotionId,
          promotionVersion: a.promotionVersion,
          userId: input.userId,
          orderGroupId: input.orderGroupId,
          amount: a.amount,
          platformFunded: a.platformFunded,
          sellerFunded: a.sellerFunded,
          dayKey,
          atMs,
        })),
      ),
    );
    if (out.kind === "recorded" && out.recorded > 0) {
      await this.deps.events.publish({ name: "voucher.redeemed", promotionId: null, orderGroupId: input.orderGroupId, atMs });
    }
    return out;
  }
}

export class ReinstateRedemptions {
  constructor(private readonly deps: PromotionDeps) {}

  /** Caller guarantees the whole order was cancelled before shipping (spec 17). */
  async execute(orderGroupId: string): Promise<number> {
    const atMs = this.deps.clock.nowMs();
    const n = await guard(() => this.deps.repo.reinstate(orderGroupId, atMs));
    if (n > 0) await this.deps.events.publish({ name: "voucher.reinstated", promotionId: null, orderGroupId, atMs });
    return n;
  }
}
