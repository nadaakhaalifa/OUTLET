import { REASON_INFO } from "./reasons.js";
import type { Fault, ReturnReason, WindowBasis } from "./reasons.js";
import type { ReturnsErrorCode } from "./errors.js";

export interface WindowConfig {
  readonly noReasonDays: number; // 14
  readonly defectDays: number; // 30
  readonly inspectionHours: number; // 48
  /** Legal refund-payment deadline counted from receipt (V7 open; assumption 14 days). */
  readonly refundDeadlineDays: number;
  readonly disputeBusinessDays: number; // 5
  readonly serialMinOrders: number; // 10
  readonly serialRatePercent: number; // 60 (strictly above)
}

export const DEFAULT_WINDOWS: WindowConfig = { noReasonDays: 14, defectDays: 30, inspectionHours: 48, refundDeadlineDays: 14, disputeBusinessDays: 5, serialMinOrders: 10, serialRatePercent: 60 };

const DAY_MS = 86_400_000;

// Copied from packages/payouts/src/domain/cycle.ts (importing it would create a package cycle).
const CAIRO = "Africa/Cairo";
const cairoFmt = new Intl.DateTimeFormat("en-CA", { timeZone: CAIRO, year: "numeric", month: "2-digit", day: "2-digit" });
/** Local calendar date in Africa/Cairo as YYYY-MM-DD (handles Egypt's DST). */
export const cairoDate = (d: Date): string => {
  const parts = new Map(cairoFmt.formatToParts(d).map((p) => [p.type, p.value] as const));
  return `${parts.get("year") ?? ""}-${parts.get("month") ?? ""}-${parts.get("day") ?? ""}`;
};
const cairoClock = new Intl.DateTimeFormat("en-GB", { timeZone: CAIRO, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** The UTC instant at which Cairo's calendar date (YYYY-MM-DD) begins. Tries the two offsets Egypt uses (+2, +3 in DST). */
const startOfCairoDay = (date: string): Date => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(y, m - 1, d);
  for (const off of [2, 3]) {
    const cand = new Date(utcMidnight - off * 3_600_000);
    if (cairoDate(cand) === date && cairoClock.format(cand) === "00:00") return cand;
  }
  return new Date(utcMidnight - 2 * 3_600_000);
};

/**
 * Inclusive end of a statutory window of `days`: the last millisecond of Cairo calendar day `days` after the delivery date
 * (delivered Cairo day 0; day 14 ends 23:59:59.999 Cairo; 00:00:00 of day 15 is refused). V7.
 */
export const windowEnd = (deliveredAt: Date, days: number): Date => {
  const [y, m, d] = cairoDate(deliveredAt).split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + days + 1)).toISOString().slice(0, 10);
  return new Date(startOfCairoDay(next).getTime() - 1);
};
export const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * DAY_MS);
export const addHours = (d: Date, hours: number): Date => new Date(d.getTime() + hours * 3_600_000);

/** Adds business days skipping Friday and Saturday (Egypt weekend). Public holidays are a V7-style follow-up. */
export const addBusinessDays = (d: Date, n: number): Date => {
  let out = d;
  let left = n;
  while (left > 0) {
    out = addDays(out, 1);
    const dow = out.getUTCDay();
    if (dow !== 5 && dow !== 6) left -= 1;
  }
  return out;
};

export interface EligibilityInput {
  readonly reason: ReturnReason;
  /** Courier-confirmed delivery time; null = not delivered yet. */
  readonly deliveredAt: Date | null;
  readonly now: Date;
  /** Any returned line sits in a category excluded by CPL (hygiene, personalised): refused unless the reason is defect class. */
  readonly nonReturnable: boolean;
  /** Any returned line carries a defect card the shopper acknowledged at checkout (ADR-0009, V19). */
  readonly disclosedDefect: boolean;
  readonly evidenceCount: number;
}

export type Eligibility =
  | { readonly ok: true; readonly windowBasis: WindowBasis; readonly windowEndsAt: Date; readonly fault: Fault; readonly photosRequired: boolean }
  | { readonly ok: false; readonly code: Extract<ReturnsErrorCode, "not_delivered" | "window_closed" | "disclosed_defect" | "non_returnable" | "photos_required"> };

/** Pure eligibility decision. The window end is inclusive and falls at the end of the Cairo calendar day (V7). */
export function checkEligibility(i: EligibilityInput, cfg: WindowConfig = DEFAULT_WINDOWS): Eligibility {
  const info = REASON_INFO[i.reason];
  if (i.deliveredAt === null) return { ok: false, code: "not_delivered" };
  if (i.reason === "defect_undisclosed" && i.disclosedDefect) return { ok: false, code: "disclosed_defect" };
  if (i.nonReturnable && !info.defectClass) return { ok: false, code: "non_returnable" };
  const windowEndsAt = windowEnd(i.deliveredAt, info.windowBasis === "defect_30d" ? cfg.defectDays : cfg.noReasonDays);
  if (i.now.getTime() > windowEndsAt.getTime()) return { ok: false, code: "window_closed" };
  if (info.photosRequired && i.evidenceCount < 1) return { ok: false, code: "photos_required" };
  return { ok: true, windowBasis: info.windowBasis, windowEndsAt, fault: info.fault, photosRequired: info.photosRequired };
}

/** Published serial-returner policy: more than 60% of >= 10 delivered orders in the last 6 months returned. Integer math. */
export const isSerialReturner = (deliveredOrders: number, returnedOrders: number, cfg: WindowConfig = DEFAULT_WINDOWS): boolean =>
  deliveredOrders >= cfg.serialMinOrders && returnedOrders * 100 > deliveredOrders * cfg.serialRatePercent;

/** Exchange-first (section 22): a size reason with the swap size in stock defaults to an exchange; the shopper may still choose a refund. */
export const decideResolution = (reason: ReturnReason, sizeSwapAvailable: boolean, shopperPrefersRefund: boolean): "exchange" | "refund" =>
  REASON_INFO[reason].sizeRelated && sizeSwapAvailable && !shopperPrefersRefund ? "exchange" : "refund";

/** Who pays the return pickup (section 22 table): seller for defects, free for a size exchange or Plus, else the shopper; serial returners lose free returns. */
export const returnShippingPayer = (reason: ReturnReason, resolution: "exchange" | "refund", isPlus: boolean, serial: boolean): "seller" | "shopper" | "free" => {
  const info = REASON_INFO[reason];
  if (info.defectClass) return "seller";
  if (serial) return "shopper";
  if (resolution === "exchange" || isPlus) return "free";
  return "shopper";
};
