import type { StoreCreditSub, Tender } from "../chart-of-accounts";
import { planRefund } from "../ledger-posting/refund-allocation";
import type {
  OriginalTender as LedgerTender,
  RefundItem,
  RefundLineState,
  RefundPlan,
  RefundPlanInput,
} from "../ledger-posting/refund-allocation";
import { money, type Money } from "../money";
import { InvalidRefundInputError } from "./errors";
import { decideRoute, type RouteDecision } from "./router";
import {
  DEFAULT_REFUND_CHOICE,
  DEFAULT_REFUND_ROUTER_CONFIG,
  type OriginalTender,
  type RefundChoice,
  type RefundRoute,
  type RefundRouterConfig,
} from "./types";

export interface RefundPlanFacts {
  readonly userId: string;
  readonly storeId: string;
  readonly commissionBps: bigint;
  readonly vatBps: bigint;
  /** Lines of the seller order: gross after item discounts, goods refunded before (INCLUDING refunds still in flight). */
  readonly lines: readonly RefundLineState[];
  readonly items: readonly RefundItem[];
  /** Voucher totals of the whole seller order. */
  readonly platformVoucher: Money;
  readonly sellerVoucher: Money;
  readonly shippingGross: Money;
  /** Group tenders; `refundedBefore` INCLUDES refunds still in flight. */
  readonly tenders: readonly OriginalTender[];
  readonly choice?: RefundChoice;
  readonly config?: RefundRouterConfig;
}

export interface RefundLegsPlan {
  /** The posting command's body: feed it to `ledgerPosting.buildEntry({ type: "refund", refundId, ...input })`. */
  readonly input: RefundPlanInput;
  readonly plan: RefundPlan;
  /** One route per tender actually drawn, amounts taken from the ledger plan (never re-allocated). */
  readonly routes: readonly RefundRoute[];
}

function code(v: string | undefined, what: string): string {
  if (v === undefined || v.length === 0) throw new InvalidRefundInputError(`tender has no ${what}`);
  return v;
}

/** How the ledger sees a tender once the channel is decided: value goes where the leg will go. */
function ledgerTender(t: OriginalTender, d: RouteDecision, userId: string): LedgerTender {
  const refunded = t.refundedBefore;
  const amount = t.amount;
  const asCredit = (sub: StoreCreditSub): Tender => ({ kind: "store_credit", userId, sub, amount });
  switch (d.channel) {
    case "store_credit":
    case "store_credit_original_sub":
      return { tender: asCredit(d.creditSub ?? { kind: "refund_credit" }), refunded };
    case "bnpl_cancel":
      return { tender: { kind: "bnpl", provider: code(t.provider, "bnpl provider"), amount }, refunded };
    case "bank_transfer_iban":
    case "wallet_transfer":
      return t.method === "cod"
        ? { tender: { kind: "cod", courier: code(t.courier, "courier"), amount }, refunded, collected: false }
        : { tender: { kind: "psp", psp: code(t.psp, "psp"), amount }, refunded };
    case "psp_original":
    case "psp_reverse":
    case "fawry_voucher":
      return { tender: { kind: "psp", psp: code(t.psp, "psp"), amount }, refunded };
  }
}

/**
 * The single refund allocation: `ledger-posting::planRefund` decides voucher release, the total
 * and the draw per tender; the legs are that draw labelled with the channel the router picks for
 * each tender. There is no second split to drift from the ledger.
 */
export function planRefundLegs(f: RefundPlanFacts): RefundLegsPlan {
  const choice = f.choice ?? DEFAULT_REFUND_CHOICE;
  const config = f.config ?? DEFAULT_REFUND_ROUTER_CONFIG;
  const decisions = f.tenders.map((t) => decideRoute(t, choice, config));
  const input: RefundPlanInput = {
    userId: f.userId,
    storeId: f.storeId,
    commissionBps: f.commissionBps,
    vatBps: f.vatBps,
    lines: f.lines,
    items: f.items,
    platformVoucher: f.platformVoucher,
    sellerVoucher: f.sellerVoucher,
    shippingGross: f.shippingGross,
    tenders: f.tenders.map((t, i) => ledgerTender(t, decisions[i] as RouteDecision, f.userId)),
    // Channels are already decided per tender above, so the ledger plan must not decide again.
    choice: "original",
  };
  const plan = planRefund(input);
  const routes: RefundRoute[] = plan.drawn.map((d) => {
    const t = f.tenders[d.index];
    const dec = decisions[d.index];
    if (t === undefined || dec === undefined) throw new InvalidRefundInputError("drawn tender is unknown");
    return { tenderId: t.id, method: t.method, amount: money(d.amount.amount), ...dec };
  });
  return { input, plan, routes };
}
