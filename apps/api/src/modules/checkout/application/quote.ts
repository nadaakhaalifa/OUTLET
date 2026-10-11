import {
  CHECKOUT_METHODS,
  InvalidCheckoutError,
  assembleQuote,
  canonicalQuote,
  effectiveUnitPrice,
  itemDiscountByStore,
  lockExpiry,
  money,
  shippingBeforePromotions,
  type CheckoutLine,
  type CheckoutMethod,
  type CheckoutQuote,
  type Money,
  type PriceLockSnapshot,
} from "../domain/bridge";
import type { BagLine, BagSnapshot, DeliveryContact, RiskDecision, StoredLine } from "../domain/ports";
import { sha256Hex } from "@outlet/idempotency";
import type { CheckoutContext } from "./context";
import { signPriceLock, verifyPriceLock } from "./price-lock-token";

export type MethodUnavailableReason =
  | "disabled"
  | "drop_items"
  | "age_restricted"
  | "risk_blocked"
  | "prepayment_required"
  | "prepaid_only"
  | "over_cod_limit";

export interface MethodAvailability {
  readonly method: CheckoutMethod;
  readonly available: boolean;
  readonly reason?: MethodUnavailableReason;
  /** BNPL only: "eligibility checked by {provider}" (spec B3). */
  readonly provider?: string;
}

export interface QuoteInput {
  readonly userId: string;
  readonly deviceId: string | null;
  readonly method: CheckoutMethod;
  readonly addressId: string | null;
  readonly codes: readonly string[];
  readonly useStoreCredit: boolean;
  readonly priceLock: string | null;
}

export interface UnavailableLine {
  readonly lineId: string;
  readonly reason: "sold_out" | "store_closed";
}

export interface QuoteOk {
  readonly kind: "ok";
  readonly quote: CheckoutQuote;
  readonly lines: readonly StoredLine[];
  readonly commissionBps: Readonly<Record<string, number>>;
  readonly buyer: DeliveryContact | null;
  readonly addressId: string | null;
  readonly unavailable: readonly UnavailableLine[];
  readonly methods: readonly MethodAvailability[];
  readonly lockToken: string;
  readonly lockExpiresAtMs: number;
  readonly cartHash: string;
  readonly codNeedsConfirmation: boolean;
  readonly plusMember: boolean;
  /** True when a still-valid lock lowered at least one price. */
  readonly lockApplied: boolean;
}

export type QuoteResult =
  | QuoteOk
  | { readonly kind: "bag_empty"; readonly unavailable: readonly UnavailableLine[] }
  | { readonly kind: "method_unavailable"; readonly method: CheckoutMethod; readonly reason: MethodUnavailableReason }
  | { readonly kind: "address_not_found" }
  | { readonly kind: "address_not_covered" };

function codDecision(d: RiskDecision, total: Money): { ok: true; confirm: boolean } | { ok: false; reason: MethodUnavailableReason } {
  switch (d.kind) {
    case "allow":
      return { ok: true, confirm: false };
    case "require_confirmation":
      return { ok: true, confirm: true };
    case "require_prepayment":
      return { ok: false, reason: "prepayment_required" };
    case "prepaid_only":
      return { ok: false, reason: "prepaid_only" };
    case "limit_value":
      return total.amount <= d.maxAmount.amount ? { ok: true, confirm: false } : { ok: false, reason: "over_cod_limit" };
    case "block":
      return { ok: false, reason: "risk_blocked" };
  }
}

/**
 * Pure quote (no writes): reprices the bag from server prices, evaluates promotions in two passes
 * (item scope first, because the free-delivery threshold is measured after item discounts and before
 * vouchers), asks tax for VAT, applies the Plus waiver, plans store credit and lists every method with
 * its availability. All fees appear here, on the first render (no drip pricing).
 */
export class QuoteCheckout {
  constructor(private readonly ctx: CheckoutContext) {}

  async execute(input: QuoteInput): Promise<QuoteResult> {
    const { ctx } = this;
    const nowMs = ctx.clock.nowMs();
    const bag: BagSnapshot = await ctx.cart.snapshot(input.userId);

    const unavailable: UnavailableLine[] = [];
    const live: BagLine[] = [];
    for (const l of bag.lines) {
      const store = bag.stores.get(l.storeId);
      if (store === undefined || !store.open) unavailable.push({ lineId: l.lineId, reason: "store_closed" });
      else if (!l.available) unavailable.push({ lineId: l.lineId, reason: "sold_out" });
      else live.push(l);
    }
    if (live.length === 0) return { kind: "bag_empty", unavailable };

    let buyer: DeliveryContact | null = null;
    if (input.addressId !== null) {
      const a = await ctx.addresses.resolve(input.userId, input.addressId);
      if (a.kind === "not_found") return { kind: "address_not_found" };
      if (a.kind === "not_covered") return { kind: "address_not_covered" };
      buyer = a.contact;
    }

    // Price lock: inside the window the shopper never pays more than the locked unit price.
    const lock: PriceLockSnapshot | null = verifyPriceLock(ctx.lockSecret, input.priceLock);
    let lockApplied = false;
    const lines: CheckoutLine[] = live.map((l) => {
      const unitPrice = effectiveUnitPrice(l.skuId, l.unitPrice, lock, input.userId, nowMs);
      if (unitPrice.amount !== l.unitPrice.amount) lockApplied = true;
      return {
        lineId: l.lineId,
        skuId: l.skuId,
        productId: l.productId,
        storeId: l.storeId,
        qty: l.qty,
        unitPrice,
        isDrop: l.isDrop,
      };
    });

    const promoMethod = input.method;
    const evalBase = {
      userId: input.userId,
      lines: lines.map((l) => ({ skuId: l.skuId, storeId: l.storeId, qty: l.qty, unitPrice: l.unitPrice })),
      codes: input.codes,
      paymentMethod: promoMethod,
      isPlus: bag.plusMember,
      atMs: nowMs,
    } as const;

    const storeTerms = new Map(
      [...bag.stores].map(([id, t]) => [
        id,
        { storeId: id, freeDeliveryThreshold: t.freeDeliveryThreshold, standardDeliveryFee: t.standardDeliveryFee },
      ]),
    );
    const standardFees = shippingBeforePromotions({ lines, stores: storeTerms, itemDiscounts: new Map(), plus: false });
    const pass1 = await ctx.promotions.evaluate({ ...evalBase, shippingFees: standardFees.fees });
    const waiver = shippingBeforePromotions({
      lines,
      stores: storeTerms,
      itemDiscounts: itemDiscountByStore(pass1, lines),
      plus: bag.plusMember,
    });
    const evaluation = await ctx.promotions.evaluate({ ...evalBase, shippingFees: waiver.fees });

    const deliveryFees = new Map<string, Money>();
    for (const [id, t] of storeTerms) deliveryFees.set(id, t.standardDeliveryFee);

    const taxQuote = await ctx.tax.quote({
      lines: live.map((l, i) => ({
        id: l.lineId,
        unitGross: lines[i]?.unitPrice ?? l.unitPrice,
        qty: l.qty,
        categoryCode: l.taxCategoryCode,
      })),
      orderDiscount: money(evaluation.merchandiseDiscount),
    });
    const lineVat = new Map(taxQuote.lines.map((t) => [t.id, t.vat]));
    const balances = await ctx.credit.balances(input.userId);

    const quote = assembleQuote({
      method: input.method,
      lines,
      evaluation,
      shippingReasons: waiver.reasons,
      deliveryFees,
      lineVat,
      vatBps: taxQuote.vatBps,
      balances,
      useStoreCredit: input.useStoreCredit,
    });

    // Method availability (kill switch, drop SKUs, age policy, COD risk).
    const disabled = await ctx.killSwitch.disabledMethods();
    const hasDrop = lines.some((l) => l.isDrop);
    const methods: MethodAvailability[] = [];
    let codNeedsConfirmation = false;
    for (const method of CHECKOUT_METHODS) {
      if (disabled.has(method)) {
        methods.push({ method, available: false, reason: "disabled" });
        continue;
      }
      if (method === "fawry" && hasDrop) {
        methods.push({ method, available: false, reason: "drop_items" });
        continue;
      }
      if (method === "bnpl") {
        const gate = await ctx.agePolicy.checkMethod(input.userId, method);
        methods.push(
          gate.allowed
            ? { method, available: true }
            : { method, available: false, reason: "age_restricted", ...(gate.provider !== undefined ? { provider: gate.provider } : {}) },
        );
        continue;
      }
      if (method === "cod") {
        const d = codDecision(
          await ctx.risk.assessCod({ userId: input.userId, deviceId: input.deviceId, total: quote.total, addressId: input.addressId }),
          quote.total,
        );
        if (d.ok) {
          methods.push({ method, available: true });
          if (input.method === "cod") codNeedsConfirmation = d.confirm;
        } else methods.push({ method, available: false, reason: d.reason });
        continue;
      }
      methods.push({ method, available: true });
    }
    const chosen = methods.find((m) => m.method === input.method);
    // A fully store-credit-covered order needs no external method, so only the saga's own gates apply.
    if (chosen === undefined || (!chosen.available && quote.tender.externalDue.amount > 0n)) {
      return { kind: "method_unavailable", method: input.method, reason: chosen?.reason ?? "disabled" };
    }
    if (!chosen.available && input.method === "cod") {
      return { kind: "method_unavailable", method: input.method, reason: chosen.reason ?? "risk_blocked" };
    }

    const lockExpiresAtMs = lockExpiry(nowMs);
    const lockToken = signPriceLock(ctx.lockSecret, {
      userId: input.userId,
      expiresAtMs: lockExpiresAtMs,
      total: quote.total.amount,
      unitPrices: new Map(lines.map((l) => [l.skuId, l.unitPrice.amount])),
    });

    const byLine = new Map(live.map((l) => [l.lineId, l]));
    const stored: StoredLine[] = quote.lines.map((q) => {
      const src = byLine.get(q.lineId);
      if (src === undefined) throw new InvalidCheckoutError(`quote line ${q.lineId} not in bag`);
      return {
        lineId: q.lineId,
        skuId: q.skuId,
        productId: q.productId,
        storeId: q.storeId,
        qty: q.qty,
        unitPrice: q.unitPrice,
        discount: q.discount,
        vat: q.vat,
        title: src.title,
        ...(src.sizeLabel !== undefined ? { sizeLabel: src.sizeLabel } : {}),
      };
    });
    const commissionBps: Record<string, number> = {};
    for (const s of quote.stores) {
      const bps = bag.stores.get(s.storeId)?.commissionBps;
      // Fail closed: a missing commission must never silently become 0% (F-4).
      if (bps === undefined || !Number.isInteger(bps) || bps < 0 || bps > 10_000) {
        throw new InvalidCheckoutError(`commission terms missing or invalid for store ${s.storeId}`);
      }
      commissionBps[s.storeId] = bps;
    }

    return {
      kind: "ok",
      quote,
      lines: stored,
      commissionBps,
      buyer,
      addressId: input.addressId,
      unavailable,
      methods,
      lockToken,
      lockExpiresAtMs,
      cartHash: sha256Hex(`${input.userId}|${canonicalQuote(quote)}`),
      codNeedsConfirmation,
      plusMember: bag.plusMember,
      lockApplied,
    };
  }
}
