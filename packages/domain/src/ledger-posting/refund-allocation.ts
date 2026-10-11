import { allocate, money, type Money } from "../money";
import { chart, type RefundInput, type Tender } from "../chart-of-accounts";
import { InvalidPostingCommandError, RefundExceedsOriginalError } from "./errors";

/** One line of the seller order being refunded against. `gross` is after item discounts, before vouchers. */
export interface RefundLineState {
  readonly lineId: string;
  readonly gross: Money;
  /** Goods value of this line refunded by earlier refunds. */
  readonly refundedBefore: Money;
}

export interface RefundItem {
  readonly lineId: string;
  /** Goods value refunded now (a whole line or a part of it). */
  readonly goods: Money;
}

/** What the shopper paid with, at order-group level, and how much has already gone back. */
export interface OriginalTender {
  readonly tender: Tender;
  readonly refunded: Money;
  /** COD only: the courier already collected the cash. Cash refunds do not exist yet, so credit is used. */
  readonly collected?: boolean;
}

export interface RefundPlanInput {
  readonly userId: string;
  readonly storeId: string;
  readonly commissionBps: bigint;
  readonly vatBps: bigint;
  readonly lines: readonly RefundLineState[];
  readonly items: readonly RefundItem[];
  /** Voucher totals on this seller order, funded by the platform and by the seller. */
  readonly platformVoucher: Money;
  readonly sellerVoucher: Money;
  readonly shippingGross?: Money;
  readonly tenders: readonly OriginalTender[];
  /** The shopper's choice where both are legal (15.6). BNPL always goes back to the provider. */
  readonly choice: "original" | "store_credit";
}

export interface RefundPlan {
  readonly input: RefundInput;
  readonly platformShare: Money;
  readonly sellerShare: Money;
  readonly total: Money;
  /** Amount drawn from each original tender, by index into `tenders`, for the caller's bookkeeping. */
  readonly drawn: readonly { readonly index: number; readonly amount: Money }[];
  /** True when part of an external payment was re-routed to refund credit (collected COD, or shopper choice). */
  readonly routedToCredit: boolean;
}

const ZERO = money(0n);
const sumAmounts = (xs: readonly Money[]): bigint => xs.reduce((a, x) => a + x.amount, 0n);

/**
 * Cumulative release of one line's voucher after `c` goods of `gross` have been refunded.
 * T(c) = floor(disc * c / gross) is monotone and never exceeds c, so a refund step never releases
 * more discount than the goods it returns. The total is split between funders as
 * P = floor(T * platform / disc), S = T - P: both monotone, exact at c = gross. Plain bigint
 * division on non-negative values is an allocation (same family as `allocate`), not a rounding
 * of money, so the half-even rule of money.ts is not involved.
 */
function cumulative(platform: bigint, seller: bigint, gross: bigint, c: bigint): { p: bigint; s: bigint } {
  const disc = platform + seller;
  if (disc === 0n) return { p: 0n, s: 0n };
  const total = (disc * c) / gross;
  const p = (total * platform) / disc;
  return { p, s: total - p };
}

/**
 * Voucher released with refunded goods. Each line's share of each voucher is fixed at order time
 * (largest remainder; the seller voucher over what the platform voucher left of each line, so a
 * line never carries more discount than its value) and released through `cumulative`, so partial
 * refunds in any order telescope to exactly the order's vouchers.
 */
export function voucherRelease(
  platformTotal: Money,
  sellerTotal: Money,
  lines: readonly RefundLineState[],
  items: readonly RefundItem[],
): { readonly platform: Money; readonly seller: Money } {
  if (platformTotal.amount < 0n || sellerTotal.amount < 0n) {
    throw new InvalidPostingCommandError("voucher must not be negative");
  }
  const grosses = lines.map((l) => l.gross.amount);
  const merchandise = grosses.reduce((a, g) => a + g, 0n);
  if (platformTotal.amount + sellerTotal.amount > merchandise) {
    throw new InvalidPostingCommandError("vouchers exceed the merchandise value of the order");
  }
  const platformLines =
    platformTotal.amount === 0n ? grosses.map(() => 0n) : allocate(platformTotal, grosses).map((m) => m.amount);
  const sellerLines =
    sellerTotal.amount === 0n
      ? grosses.map(() => 0n)
      : allocate(sellerTotal, grosses.map((g, i) => g - (platformLines[i] ?? 0n))).map((m) => m.amount);
  let platform = 0n;
  let seller = 0n;
  for (const item of items) {
    const index = lines.findIndex((l) => l.lineId === item.lineId);
    const line = lines[index];
    if (line === undefined) throw new InvalidPostingCommandError(`unknown line ${item.lineId}`);
    const pl = platformLines[index] ?? 0n;
    const sl = sellerLines[index] ?? 0n;
    const before = cumulative(pl, sl, line.gross.amount, line.refundedBefore.amount);
    const after = cumulative(pl, sl, line.gross.amount, line.refundedBefore.amount + item.goods.amount);
    platform += after.p - before.p;
    seller += after.s - before.s;
  }
  return { platform: money(platform), seller: money(seller) };
}

function validate(input: RefundPlanInput): void {
  const seen = new Set<string>();
  if (input.items.length === 0) throw new InvalidPostingCommandError("a refund needs at least one item");
  for (const item of input.items) {
    if (seen.has(item.lineId)) throw new InvalidPostingCommandError(`line ${item.lineId} listed twice`);
    seen.add(item.lineId);
    const line = input.lines.find((l) => l.lineId === item.lineId);
    if (line === undefined) throw new InvalidPostingCommandError(`unknown line ${item.lineId}`);
    if (item.goods.amount <= 0n) throw new InvalidPostingCommandError("refunded goods must be positive");
    if (line.refundedBefore.amount < 0n || line.gross.amount <= 0n) {
      throw new InvalidPostingCommandError("line state is invalid");
    }
    if (line.refundedBefore.amount + item.goods.amount > line.gross.amount) {
      throw new RefundExceedsOriginalError(`line ${item.lineId} would be refunded above its value`);
    }
  }
}

function destinationFor(
  original: OriginalTender,
  userId: string,
  amount: Money,
  choice: RefundPlanInput["choice"],
): { tender: Tender; routedToCredit: boolean } {
  const t = original.tender;
  const credit: Tender = { kind: "store_credit", userId, sub: { kind: "refund_credit" }, amount };
  switch (t.kind) {
    case "store_credit":
      // Back to the sub-balance it came from (15.2, 15.6).
      return { tender: { kind: "store_credit", userId: t.userId, sub: t.sub, amount }, routedToCredit: false };
    case "bnpl":
      // Provider cancellation only (ADR-0021 point 3). Choice does not apply.
      return { tender: { kind: "bnpl", provider: t.provider, amount }, routedToCredit: false };
    case "psp":
      return choice === "store_credit"
        ? { tender: credit, routedToCredit: true }
        : { tender: { kind: "psp", psp: t.psp, amount }, routedToCredit: false };
    case "cod":
      return choice === "original" && original.collected !== true
        ? { tender: { kind: "cod", courier: t.courier, amount }, routedToCredit: false }
        : { tender: credit, routedToCredit: true };
  }
}

/**
 * Turns "refund these lines" into the builder input: voucher shares released, destinations drawn
 * pro rata from the original tenders by remaining refundable amount.
 */
export function planRefund(input: RefundPlanInput): RefundPlan {
  validate(input);
  const goods = money(sumAmounts(input.items.map((i) => i.goods)));
  const before = money(sumAmounts(input.lines.map((l) => l.refundedBefore)));
  const released = voucherRelease(input.platformVoucher, input.sellerVoucher, input.lines, input.items);
  const platformShare = released.platform;
  const sellerShare = released.seller;
  const shipping = input.shippingGross ?? ZERO;
  const total = money(goods.amount - platformShare.amount - sellerShare.amount + shipping.amount);
  // A voucher can cover the refunded goods entirely: the seller side is still unwound, no cash moves.
  if (total.amount < 0n) throw new InvalidPostingCommandError("refund total must not be negative");

  const remaining = input.tenders.map((o) => money(o.tender.amount.amount - o.refunded.amount));
  if (remaining.some((r) => r.amount < 0n)) throw new RefundExceedsOriginalError("a tender is refunded above its amount");
  const capacity = sumAmounts(remaining);
  if (total.amount > capacity) {
    throw new RefundExceedsOriginalError(`refund ${total.amount} exceeds the ${capacity} still refundable`);
  }
  const parts = total.amount === 0n ? remaining.map(() => ZERO) : allocate(total, remaining.map((r) => r.amount));

  const merged = new Map<string, Tender>();
  const drawn: { index: number; amount: Money }[] = [];
  let routedToCredit = false;
  parts.forEach((part, index) => {
    const original = input.tenders[index];
    if (original === undefined || part.amount === 0n) return;
    drawn.push({ index, amount: part });
    const d = destinationFor(original, input.userId, part, input.choice);
    routedToCredit ||= d.routedToCredit;
    const key = tenderKey(d.tender);
    const prev = merged.get(key);
    merged.set(key, prev === undefined ? d.tender : { ...d.tender, amount: money(prev.amount.amount + part.amount) });
  });

  const refundInput: RefundInput = {
    storeId: input.storeId,
    commissionBps: input.commissionBps,
    vatBps: input.vatBps,
    goodsRefunded: goods,
    goodsRefundedBefore: before,
    platformFundedDiscount: platformShare,
    sellerFundedDiscount: sellerShare,
    ...(shipping.amount > 0n ? { shippingGross: shipping } : {}),
    destinations: [...merged.values()],
  };
  return { input: refundInput, platformShare, sellerShare, total, drawn, routedToCredit };
}

function tenderKey(t: Tender): string {
  switch (t.kind) {
    case "psp":
      return `psp:${t.psp}`;
    case "cod":
      return `cod:${t.courier}`;
    case "bnpl":
      return `bnpl:${t.provider}`;
    case "store_credit":
      return chart.storeCredit(t.userId, t.sub);
  }
}
