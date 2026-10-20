import { allocate, money, type Money } from "../money";
import { InvalidRefundInputError, RefundExceedsRefundableError } from "./errors";
import {
  DEFAULT_REFUND_CHOICE,
  DEFAULT_REFUND_ROUTER_CONFIG,
  type OriginalTender,
  type RefundChannel,
  type RefundChoice,
  type RefundRoute,
  type RefundRouterConfig,
} from "./types";

export interface RouteRefundInput {
  readonly amount: Money;
  readonly tenders: readonly OriginalTender[];
  readonly choice?: RefundChoice;
  readonly config?: RefundRouterConfig;
}

const VERIFY_PSP_REVERSE = "VR-RF-01";
const VERIFY_FAWRY = "VR-RF-02";
const VERIFY_BNPL = "VR-RF-03";
const VERIFY_PAYOUT = "VR-RF-04";

function refundable(t: OriginalTender): bigint {
  if (t.amount.currency !== "EGP" || t.refundedBefore.currency !== "EGP") {
    throw new InvalidRefundInputError(`tender ${t.id}: only EGP is supported`);
  }
  if (t.amount.amount < 0n || t.refundedBefore.amount < 0n) {
    throw new InvalidRefundInputError(`tender ${t.id}: amounts must not be negative`);
  }
  const left = t.amount.amount - t.refundedBefore.amount;
  if (left < 0n) throw new InvalidRefundInputError(`tender ${t.id}: refunded more than was paid`);
  return left;
}

export type RouteDecision = Pick<RefundRoute, "channel" | "creditSub" | "needsPayoutDetails" | "verify" | "note">;

/** The channel one tender refunds through (independent of the amount). */
export function decideRoute(t: OriginalTender, choice: RefundChoice, config: RefundRouterConfig): RouteDecision {
  const credit = (note: RouteDecision["note"] = null): RouteDecision => ({
    channel: "store_credit",
    creditSub: { kind: "refund_credit" },
    needsPayoutDetails: false,
    verify: null,
    note,
  });
  const wantsCredit = choice.preference === "store_credit";
  switch (t.method) {
    case "bnpl":
      // B3: provider cancellation only. The shopper's preference cannot change this.
      return {
        channel: "bnpl_cancel",
        creditSub: null,
        needsPayoutDetails: false,
        verify: VERIFY_BNPL,
        note: wantsCredit ? "preference_ignored_bnpl_provider_only" : null,
      };
    case "store_credit":
    case "gift_card":
      return {
        channel: "store_credit_original_sub",
        creditSub: t.creditSub ?? { kind: "refund_credit" },
        needsPayoutDetails: false,
        verify: null,
        note: null,
      };
    case "card":
    case "apple_pay":
    case "meeza":
      return wantsCredit
        ? credit()
        : { channel: "psp_original", creditSub: null, needsPayoutDetails: false, verify: null, note: null };
    case "mobile_wallet":
    case "instapay": {
      if (wantsCredit) return credit();
      if (config.pspReverse[t.method]) {
        return { channel: "psp_reverse", creditSub: null, needsPayoutDetails: false, verify: VERIFY_PSP_REVERSE, note: null };
      }
      return { channel: "bank_transfer_iban", creditSub: null, needsPayoutDetails: true, verify: VERIFY_PSP_REVERSE, note: null };
    }
    case "fawry": {
      if (wantsCredit || config.fawry === "store_credit") return { ...credit(), verify: VERIFY_FAWRY };
      return { channel: "fawry_voucher", creditSub: null, needsPayoutDetails: false, verify: VERIFY_FAWRY, note: null };
    }
    case "cod": {
      if (wantsCredit || choice.cod === "store_credit") return credit();
      const channel: RefundChannel = choice.cod === "bank_transfer" ? "bank_transfer_iban" : "wallet_transfer";
      return { channel, creditSub: null, needsPayoutDetails: true, verify: VERIFY_PAYOUT, note: null };
    }
  }
}

/**
 * RefundRouter (spec 15.6, ADR-0021 decision 3). Pure.
 *
 * Allocation across tenders: pro rata to what each tender can still be refunded, using the
 * largest-remainder `allocate` so the parts sum exactly to the refund. Compared with "external
 * method first" (which would leave the credit portion unrefunded and push cash-like value out
 * first), pro rata keeps every tender's share symmetrical to how it was paid, and no part can
 * exceed that tender's refundable amount when the total does not.
 */
export function routeRefund(input: RouteRefundInput): RefundRoute[] {
  const choice = input.choice ?? DEFAULT_REFUND_CHOICE;
  const config = input.config ?? DEFAULT_REFUND_ROUTER_CONFIG;
  if (input.amount.currency !== "EGP") throw new InvalidRefundInputError("only EGP is supported");
  if (input.amount.amount <= 0n) throw new InvalidRefundInputError("refund amount must be positive");

  const open = input.tenders
    .map((t) => ({ tender: t, left: refundable(t) }))
    .filter((x) => x.left > 0n);
  const total = open.reduce((a, x) => a + x.left, 0n);
  if (input.amount.amount > total) {
    throw new RefundExceedsRefundableError(`refund ${input.amount.amount} exceeds refundable ${total}`);
  }
  const parts = allocate(input.amount, open.map((x) => x.left));
  const routes: RefundRoute[] = [];
  open.forEach((x, i) => {
    const part = parts[i];
    if (part === undefined || part.amount === 0n) return;
    const d = decideRoute(x.tender, choice, config);
    routes.push({ tenderId: x.tender.id, method: x.tender.method, amount: money(part.amount), ...d });
  });
  return routes;
}

export function sumRoutes(routes: readonly RefundRoute[]): bigint {
  return routes.reduce((a, r) => a + r.amount.amount, 0n);
}
