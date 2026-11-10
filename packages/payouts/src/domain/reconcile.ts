import { DAY_MS } from "./eligibility.js";
import type { SettlementKind } from "./settlement-parse.js";

/** Spec T4 / SLO: unmatched lines older than 3 days escalate to Finance. Strictly older: exactly 3 days is not yet escalated. */
export const ESCALATION_AGE_MS = 3 * DAY_MS;

export const shouldEscalate = (firstSeenAt: Date, now: Date): boolean => now.getTime() - firstSeenAt.getTime() > ESCALATION_AGE_MS;

export interface IntentView {
  readonly id: string;
  readonly provider: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: string;
}
export interface LineView {
  readonly kind: SettlementKind;
  readonly amountMinor: bigint;
  readonly currency: string;
}
export interface LineMatch {
  readonly status: "matched" | "unmatched" | "mismatch";
  readonly detail: string | null;
}

const CAPTURED = new Set(["CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"]);
const REFUNDED = new Set(["PARTIALLY_REFUNDED", "REFUNDED"]);
const ok: LineMatch = { status: "matched", detail: null };

/** Pure matching rule of a PSP settlement line against the payment intent found by provider reference. */
export const matchSettlementLine = (line: LineView, intent: IntentView | undefined): LineMatch => {
  switch (line.kind) {
    case "fee":
      return ok;
    case "chargeback":
    case "payout":
      return { status: "unmatched", detail: "manual_review" };
    case "capture":
    case "refund": {
      if (intent === undefined) return { status: "unmatched", detail: "no_payment_intent" };
      if (intent.currency !== line.currency) return { status: "mismatch", detail: "currency_differs" };
      if (line.kind === "capture") {
        if (!CAPTURED.has(intent.status)) return { status: "mismatch", detail: "intent_not_captured" };
        return intent.amountMinor === line.amountMinor ? ok : { status: "mismatch", detail: "amount_differs" };
      }
      if (!REFUNDED.has(intent.status)) return { status: "mismatch", detail: "intent_not_refunded" };
      return line.amountMinor <= intent.amountMinor ? ok : { status: "mismatch", detail: "refund_exceeds_capture" };
    }
  }
};
