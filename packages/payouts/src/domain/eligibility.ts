export const DAY_MS = 86_400_000;
/** Spec: eligible when the seller order is CLOSED (delivery + return window) and 3 further days have passed. */
export const DEFAULT_GRACE_DAYS = 3;

export const eligibleAt = (closedAt: Date, graceDays: number = DEFAULT_GRACE_DAYS): Date => {
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 60) throw new RangeError("graceDays must be an integer from 0 to 60");
  return new Date(closedAt.getTime() + graceDays * DAY_MS);
};

export interface OpenHold {
  /** null = the whole store is on hold; otherwise only that seller order. */
  readonly sellerOrderId: string | null;
}

export interface EligibilityInput {
  readonly status: "PENDING" | "AVAILABLE" | "SCHEDULED" | "SENT" | "PAID";
  readonly sellerOrderId: string;
  readonly eligibleAt: Date | null;
  readonly now: Date;
  readonly holds: readonly OpenHold[];
}

/** Boundary is inclusive: at exactly closed_at + grace the accrual is eligible. A hold (dispute, risk, kyc) always wins. */
export const isEligible = (a: EligibilityInput): boolean => {
  if (a.status !== "AVAILABLE" || a.eligibleAt === null) return false;
  if (a.eligibleAt.getTime() > a.now.getTime()) return false;
  return !a.holds.some((h) => h.sellerOrderId === null || h.sellerOrderId === a.sellerOrderId);
};
