import { MS_PER_DAY, MS_PER_HOUR } from "./types";
import type {
  LocalizedReason,
  ReturnClass,
  ReturnReason,
  ReturnResolution,
  ShippingPayer,
  WindowClass,
} from "./types";

/**
 * Published return policy constants (spec 22, CPL 181/2018). VERIFY BEFORE LAUNCH with counsel
 * (docs/compliance/verify-register.md row 7). Production reads them from `return_policy_rules`;
 * these are the defaults and the single place the engine takes them from.
 */
export const RETURN_POLICY = {
  changeOfMindDays: 14,
  sizeExchangeDays: 14,
  defectDays: 30,
  /** A whole seller order returned within this many days also gets its delivery fee back. */
  wholeOrderDeliveryFeeDays: 7,
  inspectionHours: 48,
  /** Not in the spec; a safe default recorded in docs/specs/returns.md. */
  disputeWindowDays: 7,
  disputeReviewBusinessDays: 5,
  maxPhotos: 8,
} as const;

const SELLER_FAULT: readonly ReturnReason[] = ["defective", "not_as_described", "wrong_item"];

/** Non-conformance the seller is answerable for (30 day right, seller pays shipping). */
export function isSellerFault(reason: ReturnReason): boolean {
  return SELLER_FAULT.includes(reason);
}

/** Reasons that never count against a shopper in the serial-returner rate. */
export function isNoFaultOfShopper(reason: ReturnReason): boolean {
  return isSellerFault(reason) || reason === "late";
}

export function windowClassOf(reason: ReturnReason): WindowClass {
  switch (reason) {
    case "defective":
    case "not_as_described":
    case "wrong_item":
      return "defect";
    case "too_small":
    case "too_large":
      return "size_exchange";
    case "changed_mind":
    case "late":
      return "change_of_mind";
  }
}

export function windowDays(windowClass: WindowClass): number {
  switch (windowClass) {
    case "defect":
      return RETURN_POLICY.defectDays;
    case "size_exchange":
      return RETURN_POLICY.sizeExchangeDays;
    case "change_of_mind":
      return RETURN_POLICY.changeOfMindDays;
  }
}

/** End of the window (inclusive): exact 24 h periods from the courier-confirmed delivery instant. */
export function windowEndsAtMs(deliveredAtMs: number, windowClass: WindowClass): number {
  return deliveredAtMs + windowDays(windowClass) * MS_PER_DAY;
}

export function inspectionDueAtMs(receivedAtMs: number): number {
  return receivedAtMs + RETURN_POLICY.inspectionHours * MS_PER_HOUR;
}

/** Silence past the deadline auto-approves; the boundary instant already counts as elapsed. */
export function isInspectionOverdue(dueAtMs: number, nowMs: number): boolean {
  return nowMs >= dueAtMs;
}

export function disputeWindowEndsAtMs(rejectedAtMs: number): number {
  return rejectedAtMs + RETURN_POLICY.disputeWindowDays * MS_PER_DAY;
}

export const INELIGIBLE_CODES = [
  "not_delivered",
  "non_returnable_class",
  "window_elapsed",
  "qty_exceeds_returnable",
  "photos_required",
  "exchange_sku_required",
] as const;
export type IneligibleCode = (typeof INELIGIBLE_CODES)[number];

const REASONS: Readonly<Record<IneligibleCode, LocalizedReason>> = {
  not_delivered: {
    ar: "لا يمكن طلب الإرجاع قبل تأكيد التسليم من شركة الشحن.",
    en: "A return can only be requested after the courier has confirmed delivery.",
  },
  non_returnable_class: {
    ar: "هذا المنتج غير قابل للإرجاع لأسباب النظافة أو لأنه مُخصّص، إلا إذا كان معيبًا أو مخالفًا للوصف.",
    en: "This item cannot be returned for hygiene or personalization reasons, unless it is defective or not as described.",
  },
  window_elapsed: {
    ar: "انتهت مدة الإرجاع لهذا السبب. مدة الإرجاع دون سبب 14 يومًا ومدة العيوب 30 يومًا من تاريخ التسليم.",
    en: "The return period for this reason has ended. Change of mind is 14 days and defects are 30 days from delivery.",
  },
  qty_exceeds_returnable: {
    ar: "الكمية المطلوبة أكبر من الكمية المتاحة للإرجاع لهذا المنتج.",
    en: "The quantity is more than what can still be returned for this item.",
  },
  photos_required: {
    ar: "يجب إرفاق صورة واحدة على الأقل للمنتج المعيب أو المخالف للوصف.",
    en: "At least one photo is required for a defective or not-as-described item.",
  },
  exchange_sku_required: {
    ar: "اختر المقاس أو المنتج البديل لإتمام الاستبدال.",
    en: "Choose the replacement size or item to complete an exchange.",
  },
};

export function ineligibleReason(code: IneligibleCode): LocalizedReason {
  return REASONS[code];
}

export interface ReturnRequestFacts {
  readonly reason: ReturnReason;
  readonly resolution: ReturnResolution;
  readonly qty: number;
  /** Units of the line not already in a live or completed return. */
  readonly openQty: number;
  readonly returnClass: ReturnClass;
  /** Courier-confirmed delivery. Null until delivered. */
  readonly deliveredAtMs: number | null;
  readonly nowMs: number;
  readonly photoCount: number;
  readonly hasExchangeSku: boolean;
  readonly plusMember: boolean;
  readonly freeReturnsRemoved: boolean;
  /** No earlier exchange has been made on this line. */
  readonly firstExchangeForLine: boolean;
}

export type ReturnEligibility =
  | {
      readonly eligible: true;
      readonly windowClass: WindowClass;
      readonly windowEndsAtMs: number;
      readonly shippingPayer: ShippingPayer;
    }
  | {
      readonly eligible: false;
      readonly code: IneligibleCode;
      readonly reason: LocalizedReason;
      readonly windowEndsAtMs: number | null;
    };

const no = (code: IneligibleCode, windowEnds: number | null): ReturnEligibility => ({
  eligible: false,
  code,
  reason: ineligibleReason(code),
  windowEndsAtMs: windowEnds,
});

export function shippingPayerFor(f: Pick<ReturnRequestFacts, "reason" | "resolution" | "plusMember" | "freeReturnsRemoved" | "firstExchangeForLine">): ShippingPayer {
  if (isSellerFault(f.reason)) return "seller";
  if (f.reason === "late") return "platform_free";
  if (f.freeReturnsRemoved) return "shopper";
  if (f.plusMember) return "platform_free";
  if (windowClassOf(f.reason) === "size_exchange" && f.resolution === "exchange" && f.firstExchangeForLine) {
    return "platform_free";
  }
  return "shopper";
}

/** Pure eligibility decision for a return request. The clock is an input, never read. */
export function evaluateReturnRequest(f: ReturnRequestFacts): ReturnEligibility {
  if (f.deliveredAtMs === null || f.deliveredAtMs > f.nowMs) return no("not_delivered", null);
  const windowClass = windowClassOf(f.reason);
  const endsAt = windowEndsAtMs(f.deliveredAtMs, windowClass);
  if (f.returnClass !== "standard" && !isSellerFault(f.reason)) return no("non_returnable_class", endsAt);
  if (f.nowMs > endsAt) return no("window_elapsed", endsAt);
  if (!Number.isInteger(f.qty) || f.qty < 1 || f.qty > f.openQty) return no("qty_exceeds_returnable", endsAt);
  if ((f.reason === "defective" || f.reason === "not_as_described") && f.photoCount < 1) {
    return no("photos_required", endsAt);
  }
  if (f.resolution === "exchange" && !f.hasExchangeSku) return no("exchange_sku_required", endsAt);
  return { eligible: true, windowClass, windowEndsAtMs: endsAt, shippingPayer: shippingPayerFor(f) };
}
