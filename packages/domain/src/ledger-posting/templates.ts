import {
  clearingSettled,
  giftCardRedeemed,
  giftCardSold,
  orderRecognised,
  plusCharged,
  plusRevenueRecognised,
  refundIssued,
  sellerPayout,
  sellerPromoNetted,
  storeCreditExpired,
  storeCreditGranted,
  type ClearingParty,
  type EntryMeta,
  type SellerOrderInput,
  type StoreCreditSub,
  type Tender,
  type SubBalanceSpend,
} from "../chart-of-accounts";
import type { JournalEntry } from "../ledger";
import { allocate, money, percentOfBps, type Money } from "../money";
import { InvalidPostingCommandError } from "./errors";
import { planRefund, type RefundPlan, type RefundPlanInput } from "./refund-allocation";

export interface PostingMeta {
  readonly id: string;
  readonly occurredAt: Date;
}

export type ExternalTender =
  | { readonly kind: "psp"; readonly psp: string }
  | { readonly kind: "cod"; readonly courier: string }
  | { readonly kind: "bnpl"; readonly provider: string };

export interface StoreOrderCommand {
  readonly storeId: string;
  /** Gross merchandise after item-level discounts, before vouchers. Commission base. */
  readonly merchandise: Money;
  readonly commissionBps: bigint;
  /** A voucher the seller itself funds for its own store. */
  readonly storeVoucher?: Money;
}

export interface PlatformVoucher {
  /** Cart-level voucher, split across seller orders by merchandise value. */
  readonly total: Money;
  /** Share of each allocated part the seller funds (co-funding). 0 means fully platform funded. */
  readonly sellerShareBps?: bigint;
}

export interface OrderCommandBase {
  readonly orderGroupId: string;
  readonly storeOrders: readonly StoreOrderCommand[];
  readonly platformVoucher?: PlatformVoucher;
  readonly shippingGross: Money;
  readonly vatBps: bigint;
  /** The non-credit tender. null only when store credit covers everything. */
  readonly external: ExternalTender | null;
  readonly storeCredit?: { readonly userId: string; readonly spend: readonly SubBalanceSpend[] };
}

export type PostingCommand =
  | ({ readonly type: "order_paid" } & OrderCommandBase)
  | ({ readonly type: "order_cod_confirmed" } & OrderCommandBase)
  | {
      readonly type: "cod_collected";
      readonly remittanceId: string;
      readonly courier: string;
      readonly gross: Money;
      readonly fee: Money;
      readonly bankAccount: string;
    }
  | {
      readonly type: "bnpl_settled";
      readonly settlementId: string;
      readonly provider: string;
      readonly gross: Money;
      readonly fee: Money;
      readonly bankAccount: string;
    }
  | {
      readonly type: "psp_settled";
      readonly settlementId: string;
      readonly psp: string;
      readonly gross: Money;
      readonly fee: Money;
      readonly bankAccount: string;
    }
  | ({ readonly type: "refund"; readonly refundId: string } & RefundPlanInput)
  | {
      readonly type: "seller_payout";
      readonly payoutId: string;
      readonly storeId: string;
      readonly amount: Money;
      readonly bankAccount: string;
    }
  | { readonly type: "seller_promo_netted"; readonly ref: string; readonly storeId: string; readonly amount: Money }
  | {
      readonly type: "store_credit_issue";
      readonly grantId: string;
      readonly userId: string;
      readonly sub: PromoSub;
      readonly amount: Money;
    }
  | {
      readonly type: "store_credit_expire";
      readonly expiryId: string;
      readonly userId: string;
      readonly sub: PromoSub;
      readonly amount: Money;
    }
  | { readonly type: "gift_card_sold"; readonly cardId: string; readonly tender: Tender }
  | {
      readonly type: "gift_card_redeemed";
      readonly cardId: string;
      readonly redemptionId: string;
      readonly userId: string;
      readonly amount: Money;
    }
  | { readonly type: "plus_charged"; readonly invoiceId: string; readonly tender: Tender; readonly vatBps: bigint }
  | {
      readonly type: "plus_revenue_recognised";
      readonly invoiceId: string;
      readonly period: number;
      readonly amount: Money;
    };

export type PromoSub = Exclude<StoreCreditSub, { kind: "refund_credit" } | { kind: "gift_card" }>;

export type PostingCommandType = PostingCommand["type"];

const ZERO = money(0n);

/** Gift card sale and redemption sit behind the `gift_card_sales` kill switch (ADR-0003). */
export function requiresGiftCardFlag(cmd: PostingCommand): boolean {
  return cmd.type === "gift_card_sold" || cmd.type === "gift_card_redeemed";
}

interface Keyed {
  readonly key: string;
  readonly ref: { readonly type: string; readonly id: string };
}

/** Idempotency key and reference for a command. Pure and total. */
export function keyOf(cmd: PostingCommand): Keyed {
  switch (cmd.type) {
    case "order_paid":
    case "order_cod_confirmed":
      return { key: `${cmd.type}:${cmd.orderGroupId}`, ref: { type: "order_group", id: cmd.orderGroupId } };
    case "cod_collected":
      return { key: `cod_collected:${cmd.remittanceId}`, ref: { type: "cod_remittance", id: cmd.remittanceId } };
    case "bnpl_settled":
      return { key: `bnpl_settled:${cmd.settlementId}`, ref: { type: "bnpl_settlement", id: cmd.settlementId } };
    case "psp_settled":
      return { key: `psp_settled:${cmd.settlementId}`, ref: { type: "psp_settlement", id: cmd.settlementId } };
    case "refund":
      return { key: `refund:${cmd.refundId}:${cmd.storeId}`, ref: { type: "refund", id: cmd.refundId } };
    case "seller_payout":
      return { key: `seller_payout:${cmd.payoutId}`, ref: { type: "payout", id: cmd.payoutId } };
    case "seller_promo_netted":
      return { key: `seller_promo_netted:${cmd.ref}:${cmd.storeId}`, ref: { type: "seller_promo", id: cmd.ref } };
    case "store_credit_issue":
      return { key: `store_credit_issue:${cmd.grantId}`, ref: { type: "store_credit_grant", id: cmd.grantId } };
    case "store_credit_expire":
      return { key: `store_credit_expire:${cmd.expiryId}`, ref: { type: "store_credit_expiry", id: cmd.expiryId } };
    case "gift_card_sold":
      return { key: `gift_card_sold:${cmd.cardId}`, ref: { type: "gift_card", id: cmd.cardId } };
    case "gift_card_redeemed":
      return {
        key: `gift_card_redeemed:${cmd.cardId}:${cmd.redemptionId}`,
        ref: { type: "gift_card", id: cmd.cardId },
      };
    case "plus_charged":
      return { key: `plus_charged:${cmd.invoiceId}`, ref: { type: "subscription_invoice", id: cmd.invoiceId } };
    case "plus_revenue_recognised":
      return {
        key: `plus_revenue_recognised:${cmd.invoiceId}:${cmd.period}`,
        ref: { type: "subscription_invoice", id: cmd.invoiceId },
      };
  }
}

export interface OrderPlan {
  readonly sellerOrders: readonly SellerOrderInput[];
  readonly payable: Money;
  readonly credit: Money;
  readonly external: Money;
}

/** Splits vouchers per seller order and computes what the shopper owes. Pure; used by tests as an oracle. */
export function planOrder(cmd: OrderCommandBase): OrderPlan {
  if (cmd.storeOrders.length === 0) throw new InvalidPostingCommandError("an order needs a seller order");
  const stores = new Set(cmd.storeOrders.map((s) => s.storeId));
  if (stores.size !== cmd.storeOrders.length) throw new InvalidPostingCommandError("a store appears twice");

  const voucher = cmd.platformVoucher?.total ?? ZERO;
  if (voucher.amount < 0n) throw new InvalidPostingCommandError("voucher must not be negative");
  const shareBps = cmd.platformVoucher?.sellerShareBps ?? 0n;
  if (shareBps < 0n || shareBps > 10_000n) throw new InvalidPostingCommandError("sellerShareBps out of range");
  const parts =
    voucher.amount === 0n ? cmd.storeOrders.map(() => ZERO) : allocate(voucher, cmd.storeOrders.map((s) => s.merchandise.amount));

  let discounts = 0n;
  const sellerOrders = cmd.storeOrders.map((s, i): SellerOrderInput => {
    const part = parts[i] ?? ZERO;
    const coFunded = percentOfBps(part, shareBps);
    const platformFunded = money(part.amount - coFunded.amount);
    const sellerFunded = money(coFunded.amount + (s.storeVoucher?.amount ?? 0n));
    discounts += platformFunded.amount + sellerFunded.amount;
    return {
      storeId: s.storeId,
      merchandise: s.merchandise,
      commissionBps: s.commissionBps,
      platformFundedDiscount: platformFunded,
      sellerFundedDiscount: sellerFunded,
    };
  });
  const merchandise = cmd.storeOrders.reduce((a, s) => a + s.merchandise.amount, 0n);
  const payable = money(merchandise - discounts + cmd.shippingGross.amount);
  const credit = money((cmd.storeCredit?.spend ?? []).reduce((a, s) => a + s.amount.amount, 0n));
  return { sellerOrders, payable, credit, external: money(payable.amount - credit.amount) };
}

function orderEntry(cmd: Extract<PostingCommand, { type: "order_paid" | "order_cod_confirmed" }>, meta: EntryMeta): JournalEntry {
  const plan = planOrder(cmd);
  const tenders: Tender[] = [];
  if (cmd.storeCredit !== undefined) {
    for (const s of cmd.storeCredit.spend) {
      tenders.push({ kind: "store_credit", userId: cmd.storeCredit.userId, sub: s.sub, amount: s.amount });
    }
  }
  if (cmd.external === null) {
    if (plan.external.amount !== 0n) {
      throw new InvalidPostingCommandError(`store credit leaves ${plan.external.amount} piastres unpaid`);
    }
    if (cmd.type === "order_cod_confirmed") {
      throw new InvalidPostingCommandError("a cash on delivery order needs a courier");
    }
  } else {
    if (cmd.type === "order_paid" && cmd.external.kind === "cod") {
      throw new InvalidPostingCommandError("cash on delivery orders are posted by order_cod_confirmed");
    }
    if (cmd.type === "order_cod_confirmed" && cmd.external.kind !== "cod") {
      throw new InvalidPostingCommandError("order_cod_confirmed needs a cod external tender");
    }
    if (plan.external.amount <= 0n) {
      throw new InvalidPostingCommandError("store credit already covers the order; remove the external tender");
    }
    tenders.push({ ...cmd.external, amount: plan.external });
  }
  return orderRecognised(
    { sellerOrders: plan.sellerOrders, shippingGross: cmd.shippingGross, vatBps: cmd.vatBps, tenders },
    meta,
  );
}

const party = (cmd: { type: string; courier?: string; provider?: string; psp?: string }): ClearingParty => {
  if (cmd.type === "cod_collected" && cmd.courier !== undefined) return { kind: "cod", courier: cmd.courier };
  if (cmd.type === "bnpl_settled" && cmd.provider !== undefined) return { kind: "bnpl", provider: cmd.provider };
  if (cmd.psp !== undefined) return { kind: "psp", psp: cmd.psp };
  throw new InvalidPostingCommandError("settlement needs a party");
};

/** Builds the balanced entry for a command. Throws typed errors, never returns a partial entry. */
export function buildEntry(cmd: PostingCommand, meta: PostingMeta): JournalEntry {
  const { key, ref } = keyOf(cmd);
  const m: EntryMeta = { id: meta.id, occurredAt: meta.occurredAt, idempotencyKey: key, ref };
  switch (cmd.type) {
    case "order_paid":
    case "order_cod_confirmed":
      return orderEntry(cmd, m);
    case "cod_collected":
    case "bnpl_settled":
    case "psp_settled":
      return clearingSettled({ party: party(cmd), gross: cmd.gross, fee: cmd.fee, bankAccount: cmd.bankAccount }, m);
    case "refund":
      return refundIssued(planRefund(cmd).input, m);
    case "seller_payout":
      return sellerPayout({ storeId: cmd.storeId, amount: cmd.amount, bankAccount: cmd.bankAccount }, m);
    case "seller_promo_netted":
      return sellerPromoNetted({ storeId: cmd.storeId, amount: cmd.amount }, m);
    case "store_credit_issue":
      return storeCreditGranted({ userId: cmd.userId, sub: cmd.sub, amount: cmd.amount }, m);
    case "store_credit_expire":
      return storeCreditExpired({ userId: cmd.userId, sub: cmd.sub, amount: cmd.amount }, m);
    case "gift_card_sold":
      return giftCardSold({ tender: cmd.tender }, m);
    case "gift_card_redeemed":
      return giftCardRedeemed({ userId: cmd.userId, cardId: cmd.cardId, amount: cmd.amount }, m);
    case "plus_charged":
      return plusCharged({ tender: cmd.tender, vatBps: cmd.vatBps }, m);
    case "plus_revenue_recognised":
      return plusRevenueRecognised({ amount: cmd.amount }, m);
  }
}

export function refundPlanOf(cmd: Extract<PostingCommand, { type: "refund" }>): RefundPlan {
  return planRefund(cmd);
}
