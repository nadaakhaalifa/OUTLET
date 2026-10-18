import {
  COMMERCE_BENEFIT_KEYS,
  entitlementEndsAt,
  entitlementGrants,
  isEntitled,
  type PlusSubscription,
} from "../domain/bridge";
import type { Clock, IdPort, SavingsRow, SubscriptionStore } from "../domain/ports";

export interface EntitlementView {
  readonly entitled: boolean;
  readonly endsAtMs: number | null;
  readonly groups: { readonly commerce_benefits: readonly string[]; readonly app_features: readonly string[] };
}

const NONE: EntitlementView = {
  entitled: false,
  endsAtMs: null,
  groups: { commerce_benefits: [], app_features: [] },
};

export function viewOf(sub: PlusSubscription | null, nowMs: number): EntitlementView {
  if (sub === null || !isEntitled(sub, nowMs)) return NONE;
  const g = entitlementGrants();
  return {
    entitled: true,
    endsAtMs: entitlementEndsAt(sub),
    groups: {
      commerce_benefits: g.filter((x) => x.group === "commerce_benefits").map((x) => x.key),
      app_features: g.filter((x) => x.group === "app_features").map((x) => x.key),
    },
  };
}

/**
 * Entitlement reader for other modules (checkout delivery fee, coins, returns). Time based truth:
 * the answer is computed from the subscription at the instant asked, so benefits end exactly at
 * period_end and the checkout fee is recomputed at commit with the state of that instant.
 */
export class PlusEntitlements {
  constructor(
    private readonly store: SubscriptionStore,
    private readonly clock: Clock,
    private readonly seats?: SeatEntitlementReader,
  ) {}
  async forUser(userId: string): Promise<EntitlementView> {
    return entitlementViewFor(this.store, this.clock, this.seats, userId);
  }
}

/** Family seats (Phase 3): the instant a user's seat entitles them, or null. Never throws for a non member. */
export interface SeatEntitlementReader {
  endsAt(userId: string): Promise<number | null>;
}

/** A seat grants the same commerce benefits as an own subscription, until the seat's end instant. */
export function viewFromEnd(endMs: number | null): EntitlementView {
  if (endMs === null) return NONE;
  const g = entitlementGrants();
  return {
    entitled: true,
    endsAtMs: endMs,
    groups: {
      commerce_benefits: g.filter((x) => x.group === "commerce_benefits").map((x) => x.key),
      app_features: g.filter((x) => x.group === "app_features").map((x) => x.key),
    },
  };
}

/** Own subscription first; a family seat fills in when the user has no entitling plan of their own. */
async function entitlementViewFor(
  store: SubscriptionStore,
  clock: Clock,
  seats: SeatEntitlementReader | undefined,
  userId: string,
): Promise<EntitlementView> {
  const now = clock.nowMs();
  const own = viewOf(await store.getLiveByUser(userId), now);
  if (seats === undefined) return own;
  const seatEnd = await seats.endsAt(userId);
  if (seatEnd === null) return own;
  if (!own.entitled || own.endsAtMs === null || seatEnd > own.endsAtMs) return viewFromEnd(seatEnd);
  return own;
}

export interface MyPlusView {
  readonly subscription: PlusSubscription | null;
  readonly entitlements: EntitlementView;
  readonly savings: { readonly totalMinor: bigint; readonly recent: readonly SavingsRow[] };
}

export class GetMyPlus {
  constructor(
    private readonly store: SubscriptionStore,
    private readonly clock: Clock,
    private readonly seats?: SeatEntitlementReader,
  ) {}
  async execute(userId: string): Promise<MyPlusView> {
    const sub = await this.store.getLatestByUser(userId);
    const [total, recent] = await Promise.all([this.store.totalSavedMinor(userId), this.store.listSavings(userId, 10)]);
    const entitlements = await entitlementViewFor(this.store, this.clock, this.seats, userId);
    return { subscription: sub, entitlements, savings: { totalMinor: total, recent } };
  }
}

export type BenefitResult =
  | { readonly kind: "recorded" }
  | { readonly kind: "already_recorded" }
  | { readonly kind: "not_entitled" }
  | { readonly kind: "unknown_benefit" };

/** System writes only (no HTTP route): called when an order group applies a Plus benefit. */
export class RecordBenefitUsed {
  constructor(
    private readonly store: SubscriptionStore,
    private readonly clock: Clock,
    private readonly ids: IdPort,
    private readonly seats?: SeatEntitlementReader,
  ) {}
  async execute(i: {
    readonly userId: string;
    readonly orderGroupId: string;
    readonly benefit: string;
    readonly amountSavedMinor: bigint;
  }): Promise<BenefitResult> {
    if (!(COMMERCE_BENEFIT_KEYS as readonly string[]).includes(i.benefit) || i.amountSavedMinor < 0n) {
      return { kind: "unknown_benefit" };
    }
    const now = this.clock.nowMs();
    const sub = await this.store.getLiveByUser(i.userId);
    const ownEntitled = sub !== null && isEntitled(sub, now);
    // A family seat entitles per member order; the savings row is the member's own.
    const seatEntitled = !ownEntitled && this.seats !== undefined && (await this.seats.endsAt(i.userId)) !== null;
    if (!ownEntitled && !seatEntitled) return { kind: "not_entitled" };
    const r = await this.store.addSavings(
      {
        id: this.ids.uuidV7(),
        userId: i.userId,
        orderGroupId: i.orderGroupId,
        benefit: i.benefit,
        amountSavedMinor: i.amountSavedMinor,
        createdAtMs: now,
        reversedAtMs: null,
      },
      [{ type: "plus.benefit_used", userId: i.userId, orderGroupId: i.orderGroupId, benefit: i.benefit }],
    );
    return r === "added" ? { kind: "recorded" } : { kind: "already_recorded" };
  }
}

/** An order that used a benefit and was cancelled: the savings row is reversed, nothing else changes. */
export class ReverseBenefit {
  constructor(
    private readonly store: SubscriptionStore,
    private readonly clock: Clock,
  ) {}
  async execute(orderGroupId: string): Promise<{ readonly reversed: number }> {
    const n = await this.store.reverseSavings(orderGroupId, this.clock.nowMs(), (userId) => [
      { type: "plus.benefit_reversed", userId, orderGroupId },
    ]);
    return { reversed: n };
  }
}
