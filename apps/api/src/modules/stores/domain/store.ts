import {
  defineMachine,
  kycMachine,
  type KycContext,
  type KycEvent,
  type KycState,
} from "@outlet/domain";

export const STORE_KINDS = ["local", "global"] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

export const STORE_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "SUSPENDED"] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

export const WORLDS = ["local", "global", "everything", "my_stores"] as const;
export type World = (typeof WORLDS)[number];

export const SORTS = ["trending", "biggest_verified_discount", "new_drops", "fastest_delivery", "name"] as const;
export type Sort = (typeof SORTS)[number];

export const MAX_FAVORITE_STORES = 30;

/** Derived directory statistics. Written by jobs and pricing-integrity, never by sellers. */
export interface StoreStats {
  readonly maxVerifiedDiscountPct: number | null;
  readonly ratingAvg: number | null;
  readonly ratingCount: number;
  readonly liveDrop: boolean;
  readonly trendingScore: number;
  readonly lastDropAtMs: number | null;
  readonly p80DeliveryHours: number | null;
}

export interface LegalIdentity {
  readonly legalNameAr: string;
  readonly legalNameEn: string | null;
  readonly commercialRegisterNo: string | null;
  readonly taxCardNo: string | null;
  readonly governorate: string;
}

export interface Store {
  readonly id: string;
  readonly sellerId: string;
  readonly kind: StoreKind;
  readonly slug: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly descriptionAr: string | null;
  readonly descriptionEn: string | null;
  readonly status: StoreStatus;
  /** Cache of the seller KYC state (machine lives in packages/domain). */
  readonly sellerKycState: KycState;
  readonly healthScore: number | null;
  readonly verifiedBadge: boolean;
  readonly logoUrl: string | null;
  readonly coverUrl: string | null;
  /** Piastres. */
  readonly freeDeliveryThresholdAmount: bigint;
  readonly stats: StoreStats;
  readonly legalIdentity: LegalIdentity | null;
}

/**
 * A store is shopper-visible only when it trades (ACTIVE or on vacation), its seller is KYC approved
 * and its legal identity is published (B5: every listing shows supplier identity; fail closed).
 */
export function isShopperVisible(store: Pick<Store, "status" | "sellerKycState" | "legalIdentity">): boolean {
  return (
    (store.status === "ACTIVE" || store.status === "PAUSED") &&
    store.sellerKycState === "APPROVED" &&
    store.legalIdentity !== null
  );
}

export type HiddenReason = "suspended" | "unavailable";

/**
 * Why a stored favourite is not shown. `suspended` covers an enforcement or KYC suspension;
 * `unavailable` everything else (draft, terminated, under review). Never reveals which internal state.
 */
export function hiddenReason(store: Pick<Store, "status" | "sellerKycState" | "legalIdentity">): HiddenReason | null {
  if (isShopperVisible(store)) return null;
  if (store.status === "SUSPENDED" || store.sellerKycState === "SUSPENDED") return "suspended";
  return "unavailable";
}

/** Health badge for the Store schema. Thresholds are a documented default (config later). */
export function healthBadge(score: number | null): "good" | "fair" | "poor" | undefined {
  if (score === null) return undefined;
  if (score >= 80) return "good";
  if (score >= 50) return "fair";
  return "poor";
}

/** Never fake discounts (A2.13): only integers 5..100 from verified claims survive. */
export function publicDiscountPct(value: number | null): number | null {
  if (value === null || !Number.isInteger(value) || value < 5 || value > 100) return null;
  return value;
}

/** Never fake reviews: no ratings means no rating. */
export function publicRating(avg: number | null, count: number): number | null {
  if (avg === null || count <= 0 || !Number.isFinite(avg) || avg < 0 || avg > 5) return null;
  return avg;
}

// ---- Store lifecycle ----------------------------------------------------------------------

export const STORE_EVENTS = ["ACTIVATE", "PAUSE", "RESUME", "SUSPEND", "REINSTATE"] as const;
export type StoreEvent = (typeof STORE_EVENTS)[number];

/** No terminal state: the platform can always reinstate or resume a store. */
export const storeStatusMachine = defineMachine<StoreStatus, StoreEvent>({
  name: "StoreStatus",
  states: STORE_STATUSES,
  events: STORE_EVENTS,
  initial: "DRAFT",
  terminal: [],
  transitions: {
    DRAFT: { ACTIVATE: { to: "ACTIVE" } },
    ACTIVE: { PAUSE: { to: "PAUSED" }, SUSPEND: { to: "SUSPENDED" } },
    PAUSED: { RESUME: { to: "ACTIVE" }, SUSPEND: { to: "SUSPENDED" } },
    SUSPENDED: { REINSTATE: { to: "ACTIVE" } },
  },
});

export class StoreRuleError extends Error {
  constructor(
    readonly code: "seller_not_approved" | "english_name_required",
    message: string,
  ) {
    super(message);
    this.name = "StoreRuleError";
  }
}

/** Pure: next status for an event, enforcing that (re)activation needs an approved seller. */
export function nextStoreStatus(store: Pick<Store, "status" | "sellerKycState"> & Partial<Pick<Store, "nameAr" | "nameEn">>, event: StoreEvent): StoreStatus {
  const next = storeStatusMachine.transition(store.status, event);
  if ((event === "ACTIVATE" || event === "REINSTATE" || event === "RESUME") && store.sellerKycState !== "APPROVED") {
    throw new StoreRuleError("seller_not_approved", `cannot ${event} a store of a seller in ${store.sellerKycState}`);
  }
  // First activation needs both display names. Resume/reinstate are exempt so legacy stores can still trade.
  if (event === "ACTIVATE" && store.nameAr !== undefined) {
    if (store.nameAr.trim().length < 2 || (store.nameEn ?? "").trim().length < 2) {
      throw new StoreRuleError("english_name_required", "a store needs an Arabic and an English name before activation");
    }
  }
  return next;
}

// ---- Seller KYC (wired to the existing machine, never redefined) ------------------------

/** Pure: next KYC state through the shared machine; throws the machine's typed errors. */
export function nextSellerKycState(state: KycState, event: KycEvent, ctx: KycContext): KycState {
  return kycMachine.transition(state, event, ctx);
}
