import {
  createJournalEntry,
  type AccountId,
  type JournalEntry,
  type Posting,
} from "../ledger";
import { allocate, money, multiplyRatio, percentOfBps, type Money } from "../money";
import { chart, type StoreCreditSub } from "./accounts";
import { InvalidChartInputError, TenderMismatchError } from "./errors";

/** Everything the persistence layer supplies. Builders never read a clock or generate ids. */
export interface EntryMeta {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly ref: { readonly type: string; readonly id: string };
}

/** A way the shopper paid, or a place a refund goes back to. */
export type Tender =
  | { readonly kind: "psp"; readonly psp: string; readonly amount: Money }
  | { readonly kind: "cod"; readonly courier: string; readonly amount: Money }
  | { readonly kind: "bnpl"; readonly provider: string; readonly amount: Money }
  | {
      readonly kind: "store_credit";
      readonly userId: string;
      readonly sub: StoreCreditSub;
      readonly amount: Money;
    };

export function tenderAccount(t: Tender): AccountId {
  switch (t.kind) {
    case "psp":
      return chart.pspClearing(t.psp);
    case "cod":
      return chart.codClearing(t.courier);
    case "bnpl":
      return chart.bnplClearing(t.provider);
    case "store_credit":
      return chart.storeCredit(t.userId, t.sub);
  }
}

const ZERO = money(0n);

function requirePositive(label: string, amount: Money): void {
  if (amount.amount <= 0n) throw new InvalidChartInputError(`${label} must be positive`);
}

function requireNonNegative(label: string, amount: Money): void {
  if (amount.amount < 0n) throw new InvalidChartInputError(`${label} must not be negative`);
}

function requireBps(label: string, bps: bigint, max = 10_000n): void {
  if (bps < 0n || bps > max) throw new InvalidChartInputError(`${label} must be between 0 and ${max} bps`);
}

/** VAT contained in a VAT-inclusive amount: gross * rate / (1 + rate), rounded once, half-even. */
export function vatIncluded(gross: Money, vatBps: bigint): Money {
  requireBps("vatBps", vatBps, 100_000n);
  return multiplyRatio(gross, vatBps, 10_000n + vatBps);
}

/** Commission on a seller order, in piastres. The single formula used by orders and refunds. */
export function commissionOf(merchandise: Money, commissionBps: bigint): Money {
  requireBps("commissionBps", commissionBps);
  return percentOfBps(merchandise, commissionBps);
}

/** VAT charged to the seller on commission (a B2B supply). Commission is VAT-exclusive. */
export function commissionVatOf(commission: Money, vatBps: bigint): Money {
  requireBps("vatBps", vatBps, 100_000n);
  return percentOfBps(commission, vatBps);
}

/** Splits a cart-level voucher over seller orders by merchandise value (largest remainder). */
export function allocateVoucher(total: Money, merchandise: readonly Money[]): Money[] {
  return allocate(total, merchandise.map((m) => m.amount));
}

type Side = "debit" | "credit";
interface Component {
  readonly account: AccountId;
  readonly side: Side;
  readonly amount: Money;
}

/** direction 1 posts components as given; -1 mirrors them (refund or reversal of an order). */
function toPostings(components: readonly Component[], direction: 1n | -1n): Posting[] {
  const postings: Posting[] = [];
  for (const c of components) {
    if (c.amount.amount === 0n) continue;
    const base = c.side === "debit" ? c.amount.amount : -c.amount.amount;
    postings.push({ account: c.account, amount: money(base * direction, c.amount.currency) });
  }
  return postings;
}

function build(meta: EntryMeta, kind: string, postings: readonly Posting[]): JournalEntry {
  return createJournalEntry({ ...meta, kind, postings });
}

function sum(values: readonly Money[]): Money {
  return money(values.reduce((acc, v) => acc + v.amount, 0n));
}

// --------------------------------------------------------------------------
// Orders and refunds
// --------------------------------------------------------------------------

export interface SellerOrderInput {
  readonly storeId: string;
  /** Gross (VAT-inclusive) merchandise after item-level discounts and before vouchers. Also the commission base. */
  readonly merchandise: Money;
  readonly commissionBps: bigint;
  /** Voucher value funded by the platform and allocated to this seller order. */
  readonly platformFundedDiscount?: Money;
  /** Voucher value funded by this seller. Fronted by the platform, recovered by netting. */
  readonly sellerFundedDiscount?: Money;
}

export interface OrderRecognisedInput {
  readonly sellerOrders: readonly SellerOrderInput[];
  /** Delivery fee charged to the shopper, VAT-inclusive, a supply by Z-OUTLET. */
  readonly shippingGross: Money;
  readonly vatBps: bigint;
  /** How the shopper paid. Must sum to merchandise + shipping - all discounts. */
  readonly tenders: readonly Tender[];
}

function sellerOrderComponents(
  so: SellerOrderInput,
  merchandise: Money,
  commission: Money,
  commissionVat: Money,
  platformDiscount: Money,
  sellerDiscount: Money,
  allowRoundingDeficit = false,
): Component[] {
  const sellerNet = money(merchandise.amount - commission.amount - commissionVat.amount);
  if (!allowRoundingDeficit && sellerNet.amount < 0n) {
    throw new InvalidChartInputError("commission and VAT exceed the merchandise value");
  }
  return [
    { account: chart.sellerPayable(so.storeId), side: "credit", amount: sellerNet },
    { account: chart.platformCommission, side: "credit", amount: commission },
    { account: chart.platformVatOutput, side: "credit", amount: commissionVat },
    { account: chart.promoExpensePlatform, side: "debit", amount: platformDiscount },
    { account: chart.promoReceivableSeller(so.storeId), side: "debit", amount: sellerDiscount },
  ];
}

function shippingComponents(shippingGross: Money, vatBps: bigint): Component[] {
  const vat = vatIncluded(shippingGross, vatBps);
  return [
    { account: chart.shippingRevenue, side: "credit", amount: money(shippingGross.amount - vat.amount) },
    { account: chart.platformVatOutput, side: "credit", amount: vat },
  ];
}

/**
 * Revenue and payables for an order, posted when money is collected (prepaid, BNPL approval, store
 * credit) or goods are delivered (COD). Per seller order the seller is credited the merchandise
 * value net of commission and VAT on commission. Vouchers do not change what sellers are owed:
 * platform-funded ones are an expense, seller-funded ones a receivable netted later.
 */
export function orderRecognised(input: OrderRecognisedInput, meta: EntryMeta): JournalEntry {
  if (input.sellerOrders.length === 0) throw new InvalidChartInputError("an order needs a seller order");
  requireNonNegative("shippingGross", input.shippingGross);
  const components: Component[] = [];
  let payable = input.shippingGross;
  for (const so of input.sellerOrders) {
    requirePositive("merchandise", so.merchandise);
    const pd = so.platformFundedDiscount ?? ZERO;
    const sd = so.sellerFundedDiscount ?? ZERO;
    requireNonNegative("platformFundedDiscount", pd);
    requireNonNegative("sellerFundedDiscount", sd);
    if (pd.amount + sd.amount > so.merchandise.amount) {
      throw new InvalidChartInputError("discounts exceed merchandise value");
    }
    const commission = commissionOf(so.merchandise, so.commissionBps);
    const commissionVat = commissionVatOf(commission, input.vatBps);
    components.push(...sellerOrderComponents(so, so.merchandise, commission, commissionVat, pd, sd));
    payable = money(payable.amount + so.merchandise.amount - pd.amount - sd.amount);
  }
  components.push(...shippingComponents(input.shippingGross, input.vatBps));
  for (const t of input.tenders) {
    requirePositive("tender amount", t.amount);
    components.push({ account: tenderAccount(t), side: "debit", amount: t.amount });
  }
  const tendered = sum(input.tenders.map((t) => t.amount));
  if (tendered.amount !== payable.amount) {
    throw new TenderMismatchError(`tenders ${tendered.amount} differ from payable ${payable.amount}`);
  }
  return build(meta, "order_recognised", toPostings(components, 1n));
}

export interface RefundInput {
  readonly storeId: string;
  readonly commissionBps: bigint;
  readonly vatBps: bigint;
  /** Merchandise value being refunded now, at the value used for the order (before vouchers). */
  readonly goodsRefunded: Money;
  /** Merchandise value of this seller order already refunded by earlier refunds. */
  readonly goodsRefundedBefore: Money;
  /** The voucher share that goes with the refunded goods, allocated by the caller. */
  readonly platformFundedDiscount?: Money;
  readonly sellerFundedDiscount?: Money;
  /** Delivery fee being returned (VAT-inclusive), for example when the seller is at fault. */
  readonly shippingGross?: Money;
  /** Where the money goes. Must sum to goods + shipping - discounts. */
  readonly destinations: readonly Tender[];
}

/**
 * A refund is the mirror of the order components for the refunded portion, paid to the chosen
 * destinations. Commission and its VAT are computed on cumulative refunded value and differenced,
 * so any sequence of partial refunds adds up to exactly the original commission and VAT.
 */
export function refundIssued(input: RefundInput, meta: EntryMeta): JournalEntry {
  requirePositive("goodsRefunded", input.goodsRefunded);
  requireNonNegative("goodsRefundedBefore", input.goodsRefundedBefore);
  const pd = input.platformFundedDiscount ?? ZERO;
  const sd = input.sellerFundedDiscount ?? ZERO;
  const shipping = input.shippingGross ?? ZERO;
  requireNonNegative("platformFundedDiscount", pd);
  requireNonNegative("sellerFundedDiscount", sd);
  requireNonNegative("shippingGross", shipping);
  if (pd.amount + sd.amount > input.goodsRefunded.amount) {
    throw new InvalidChartInputError("discounts exceed refunded merchandise value");
  }

  const cumulative = money(input.goodsRefundedBefore.amount + input.goodsRefunded.amount);
  const commAfter = commissionOf(cumulative, input.commissionBps);
  const commBefore = commissionOf(input.goodsRefundedBefore, input.commissionBps);
  const commission = money(commAfter.amount - commBefore.amount);
  const vatAfter = commissionVatOf(commAfter, input.vatBps);
  const vatBefore = commissionVatOf(commBefore, input.vatBps);
  const commissionVat = money(vatAfter.amount - vatBefore.amount);

  if (commission.amount < 0n || commissionVat.amount < 0n) {
    throw new InvalidChartInputError("refund slice is not monotone");
  }

  const components = sellerOrderComponents(
    { storeId: input.storeId, merchandise: input.goodsRefunded, commissionBps: input.commissionBps },
    input.goodsRefunded,
    commission,
    commissionVat,
    pd,
    sd,
    // Refund slices are differences of cumulative half-even roundings. True invariants only: every
    // slice commission and VAT is non-negative (checked above), and the slices telescope exactly to the
    // order-level commission, VAT and seller net. A single slice's seller net can be negative by a few
    // piastres, and the cumulative seller net is NOT guaranteed non-negative at every step. Per-line and
    // per-tender caps are enforced upstream in planRefund, so this builder opts out of the net check.
    true,
  );
  if (shipping.amount > 0n) components.push(...shippingComponents(shipping, input.vatBps));
  for (const d of input.destinations) {
    requirePositive("destination amount", d.amount);
    components.push({ account: tenderAccount(d), side: "debit", amount: d.amount });
  }
  const expected = money(input.goodsRefunded.amount - pd.amount - sd.amount + shipping.amount);
  const paidBack = sum(input.destinations.map((d) => d.amount));
  if (paidBack.amount !== expected.amount) {
    throw new TenderMismatchError(`destinations ${paidBack.amount} differ from refund ${expected.amount}`);
  }
  return build(meta, "refund_issued", toPostings(components, -1n));
}

// --------------------------------------------------------------------------
// Settlement, payouts and netting
// --------------------------------------------------------------------------

export type ClearingParty =
  | { readonly kind: "psp"; readonly psp: string }
  | { readonly kind: "cod"; readonly courier: string }
  | { readonly kind: "bnpl"; readonly provider: string };

export interface SettlementInput {
  readonly party: ClearingParty;
  /** Amount cleared from the clearing account. */
  readonly gross: Money;
  /** Fee withheld by the party. Zero if none. */
  readonly fee: Money;
  readonly bankAccount: string;
}

/** Money arriving in the bank from a PSP settlement, a courier remittance or a BNPL settlement. */
export function clearingSettled(input: SettlementInput, meta: EntryMeta): JournalEntry {
  requirePositive("gross", input.gross);
  requireNonNegative("fee", input.fee);
  if (input.fee.amount >= input.gross.amount) {
    throw new InvalidChartInputError("fee must be less than gross");
  }
  const { party } = input;
  const clearing =
    party.kind === "psp"
      ? chart.pspClearing(party.psp)
      : party.kind === "cod"
        ? chart.codClearing(party.courier)
        : chart.bnplClearing(party.provider);
  const feeAccount = party.kind === "cod" ? chart.courierFeeExpense : chart.providerFeeExpense;
  const components: Component[] = [
    { account: chart.bankSettlement(input.bankAccount), side: "debit", amount: money(input.gross.amount - input.fee.amount) },
    { account: feeAccount, side: "debit", amount: input.fee },
    { account: clearing, side: "credit", amount: input.gross },
  ];
  return build(meta, "clearing_settled", toPostings(components, 1n));
}

/** A seller payout leaving the bank. A failed payout is undone with reverseEntry. */
export function sellerPayout(
  input: { readonly storeId: string; readonly amount: Money; readonly bankAccount: string },
  meta: EntryMeta,
): JournalEntry {
  requirePositive("amount", input.amount);
  return build(
    meta,
    "seller_payout",
    toPostings(
      [
        { account: chart.sellerPayable(input.storeId), side: "debit", amount: input.amount },
        { account: chart.bankSettlement(input.bankAccount), side: "credit", amount: input.amount },
      ],
      1n,
    ),
  );
}

/** Recovers a seller-funded discount by reducing what the seller is owed. */
export function sellerPromoNetted(
  input: { readonly storeId: string; readonly amount: Money },
  meta: EntryMeta,
): JournalEntry {
  requirePositive("amount", input.amount);
  return build(
    meta,
    "seller_promo_netted",
    toPostings(
      [
        { account: chart.sellerPayable(input.storeId), side: "debit", amount: input.amount },
        { account: chart.promoReceivableSeller(input.storeId), side: "credit", amount: input.amount },
      ],
      1n,
    ),
  );
}

// --------------------------------------------------------------------------
// Gift cards and store credit
// --------------------------------------------------------------------------

function rejectStoreCredit(label: string, tender: Tender): void {
  if (tender.kind === "store_credit") {
    throw new InvalidChartInputError(`${label} cannot be bought with store credit`);
  }
  if (tender.kind === "cod") {
    throw new InvalidChartInputError(`${label} cannot be bought cash on delivery`);
  }
}

/** Sale of a gift card. VAT is not booked here: it is assumed due at redemption (VERIFY). */
export function giftCardSold(input: { readonly tender: Tender }, meta: EntryMeta): JournalEntry {
  rejectStoreCredit("a gift card", input.tender);
  requirePositive("amount", input.tender.amount);
  return build(
    meta,
    "gift_card_sold",
    toPostings(
      [
        { account: tenderAccount(input.tender), side: "debit", amount: input.tender.amount },
        { account: chart.giftCardLiability, side: "credit", amount: input.tender.amount },
      ],
      1n,
    ),
  );
}

/** Redemption converts card value into the gift_card sub-balance of the redeemer. */
export function giftCardRedeemed(
  input: { readonly userId: string; readonly cardId: string; readonly amount: Money },
  meta: EntryMeta,
): JournalEntry {
  requirePositive("amount", input.amount);
  return build(
    meta,
    "gift_card_redeemed",
    toPostings(
      [
        { account: chart.giftCardLiability, side: "debit", amount: input.amount },
        {
          account: chart.storeCredit(input.userId, { kind: "gift_card", cardId: input.cardId }),
          side: "credit",
          amount: input.amount,
        },
      ],
      1n,
    ),
  );
}

type PromoSub = Exclude<StoreCreditSub, { kind: "refund_credit" } | { kind: "gift_card" }>;

/**
 * Platform-funded credit: coins converted, referral credit, goodwill. refund_credit comes only
 * from refunds and gift_card only from redemption, so the type rules them out.
 */
export function storeCreditGranted(
  input: { readonly userId: string; readonly sub: PromoSub; readonly amount: Money },
  meta: EntryMeta,
): JournalEntry {
  requirePositive("amount", input.amount);
  return build(
    meta,
    "store_credit_granted",
    toPostings(
      [
        { account: chart.promoExpensePlatform, side: "debit", amount: input.amount },
        { account: chart.storeCredit(input.userId, input.sub), side: "credit", amount: input.amount },
      ],
      1n,
    ),
  );
}

/** Expiry of platform-funded credit. Gift-card breakage is not supported until its treatment is decided. */
export function storeCreditExpired(
  input: { readonly userId: string; readonly sub: PromoSub; readonly amount: Money },
  meta: EntryMeta,
): JournalEntry {
  requirePositive("amount", input.amount);
  return build(
    meta,
    "store_credit_expired",
    toPostings(
      [
        { account: chart.storeCredit(input.userId, input.sub), side: "debit", amount: input.amount },
        { account: chart.promoExpensePlatform, side: "credit", amount: input.amount },
      ],
      1n,
    ),
  );
}

// --------------------------------------------------------------------------
// Plus subscription
// --------------------------------------------------------------------------

/** Charge for a Plus period or term. Net revenue is deferred, VAT is booked at charge (VERIFY). */
export function plusCharged(
  input: { readonly tender: Tender; readonly vatBps: bigint },
  meta: EntryMeta,
): JournalEntry {
  rejectStoreCredit("Plus", input.tender);
  requirePositive("amount", input.tender.amount);
  const vat = vatIncluded(input.tender.amount, input.vatBps);
  return build(
    meta,
    "plus_charged",
    toPostings(
      [
        { account: tenderAccount(input.tender), side: "debit", amount: input.tender.amount },
        {
          account: chart.deferredPlusRevenue,
          side: "credit",
          amount: money(input.tender.amount.amount - vat.amount),
        },
        { account: chart.platformVatOutput, side: "credit", amount: vat },
      ],
      1n,
    ),
  );
}

/** Moves one period's share of deferred revenue into recognised revenue. */
export function plusRevenueRecognised(input: { readonly amount: Money }, meta: EntryMeta): JournalEntry {
  requirePositive("amount", input.amount);
  return build(
    meta,
    "plus_revenue_recognised",
    toPostings(
      [
        { account: chart.deferredPlusRevenue, side: "debit", amount: input.amount },
        { account: chart.plusRevenue, side: "credit", amount: input.amount },
      ],
      1n,
    ),
  );
}

/** Recognition schedule: net deferred revenue split over periods, summing exactly to the net. */
export function planPlusRecognition(net: Money, periods: number): Money[] {
  if (!Number.isInteger(periods) || periods < 1) {
    throw new InvalidChartInputError("periods must be a positive integer");
  }
  return allocate(net, Array.from({ length: periods }, () => 1n));
}

// --------------------------------------------------------------------------
// Creator commission (spec P3-04, ADR-0037). Ledger-first: these entries are posted before the
// commission row changes state. The creator is identified by user id.
// --------------------------------------------------------------------------

/** Commission earned after delivery and return-window closure. */
export function creatorCommissionAccrued(
  input: { readonly creatorId: string; readonly amount: Money },
  meta: EntryMeta,
): JournalEntry {
  requirePositive("amount", input.amount);
  return build(
    meta,
    "creator_commission_accrued",
    toPostings(
      [
        { account: chart.creatorCommissionExpense, side: "debit", amount: input.amount },
        { account: chart.creatorPayable(input.creatorId), side: "credit", amount: input.amount },
      ],
      1n,
    ),
  );
}

/**
 * Commission taken back after a refund or return. A reversing entry of the accrual shape. It may
 * drive creator_payable negative (already paid); callers report that explicitly.
 */
export function creatorCommissionClawedBack(
  input: { readonly creatorId: string; readonly amount: Money },
  meta: EntryMeta,
): JournalEntry {
  requirePositive("amount", input.amount);
  return build(
    meta,
    "creator_commission_clawed_back",
    toPostings(
      [
        { account: chart.creatorPayable(input.creatorId), side: "debit", amount: input.amount },
        { account: chart.creatorCommissionExpense, side: "credit", amount: input.amount },
      ],
      1n,
    ),
  );
}

/** A creator payout leaving the bank. A rejected payout is undone with reverseEntry. */
export function creatorPayout(
  input: { readonly creatorId: string; readonly amount: Money; readonly bankAccount: string },
  meta: EntryMeta,
): JournalEntry {
  requirePositive("amount", input.amount);
  return build(
    meta,
    "creator_payout",
    toPostings(
      [
        { account: chart.creatorPayable(input.creatorId), side: "debit", amount: input.amount },
        { account: chart.bankSettlement(input.bankAccount), side: "credit", amount: input.amount },
      ],
      1n,
    ),
  );
}
