import { money, type Money } from "./domain";
import type {
  AgePolicyPort,
  BagLine,
  BagSnapshot,
  BagStoreTerms,
  CartPort,
  CaptureResult,
  CheckoutMethod,
  ClaimResult,
  ClientAction,
  CreateIntentResult,
  HoldResult,
  InventoryPort,
  OrdersIntakePort,
  PaymentProviderPort,
  PaymentRegistry,
  PlaceOrdersCommand,
  PromotionsPort,
  ReserveResult,
  StoreCreditPort,
  TaxPort,
} from "../modules/checkout";
import type { CartRepository, CatalogPort, MembershipPort, QuoteBagForCheckout } from "../modules/cart";
import type { ClaimReservation, ReleaseReservation, ReserveStock, SkuDirectory } from "../modules/inventory";
import type { EvaluatePromotions } from "../modules/promotions";
import type { QuoteOrderTax } from "../modules/tax-eta";
import type { PlaceOrders } from "../modules/orders";
import type { CreditHolds, StoreCreditStore } from "../modules/store-credit";
import type { ClientAction as PspClientAction, CreatePaymentIntent, RefundPayment, VoidPayment } from "../modules/payments";
import { subBalanceStates } from "./credit-balances";
import type { Late } from "./late";

// --------------------------------------------------------------------------- commerce terms

/**
 * Facts the saga needs per SKU and store that no module owns yet: the seller-agreement commission
 * and the tax category of a product. There is no production source for them (VERIFY BEFORE LAUNCH,
 * VR-INT-01), so the only implementation shipped is `DevCommerceTerms`, wired outside production.
 */
export interface CommerceTermsPort {
  commissionBps(storeId: string): Promise<number>;
  taxCategoryCode(skuId: string): Promise<string>;
}

/** DEVELOPMENT FIXTURE. Never production: 15% commission and the "standard" VAT category. */
export class DevCommerceTerms implements CommerceTermsPort {
  async commissionBps(): Promise<number> {
    return 1_500;
  }
  async taxCategoryCode(): Promise<string> {
    return "standard";
  }
}

// --------------------------------------------------------------------------- cart

export interface CartAdapterDeps {
  readonly quote: Late<QuoteBagForCheckout>;
  readonly catalog: Late<CatalogPort>;
  readonly membership: Late<MembershipPort>;
  readonly repo: Late<CartRepository>;
  readonly directory: Late<SkuDirectory>;
  readonly terms: CommerceTermsPort;
  readonly nowMs: () => number;
  readonly newId: () => string;
}

/** Checkout's view of the bag: priced server-side by the cart module, never by the client. */
export class CartAdapter implements CartPort {
  constructor(private readonly d: CartAdapterDeps) {}

  async snapshot(userId: string): Promise<BagSnapshot> {
    const view = await this.d.quote.get().execute(userId);
    const storeIds = view.groups.map((g) => g.store.id);
    const [storeFacts, plusMember] = await Promise.all([
      this.d.catalog.get().stores(storeIds, userId),
      this.d.membership.get().isPlusMember(userId),
    ]);
    const lines: BagLine[] = [];
    const stores = new Map<string, BagStoreTerms>();
    for (const g of view.groups) {
      const facts = storeFacts.get(g.store.id);
      stores.set(g.store.id, {
        storeId: g.store.id,
        freeDeliveryThreshold: g.freeDelivery.threshold,
        standardDeliveryFee: facts?.standardDeliveryFee ?? g.deliveryFee,
        open: g.status === "open" && (facts?.open ?? false),
        commissionBps: await this.d.terms.commissionBps(g.store.id),
      });
      for (const l of g.lines) {
        if (l.savedForLater || !l.counted) continue;
        const loc = await this.d.directory.get().lookup(l.skuId);
        lines.push({
          lineId: l.id,
          skuId: l.skuId,
          productId: l.productId,
          storeId: g.store.id,
          qty: l.qty,
          unitPrice: l.unitPrice,
          isDrop: loc !== null && loc.dropId !== null,
          available: l.available,
          title: l.title,
          ...(l.sizeLabel === undefined ? {} : { sizeLabel: l.sizeLabel }),
          taxCategoryCode: await this.d.terms.taxCategoryCode(l.skuId),
        });
      }
    }
    return { lines, stores, plusMember };
  }

  async removePurchased(userId: string, lineIds: readonly string[]): Promise<void> {
    const drop = new Set(lineIds);
    const repo = this.d.repo.get();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const cart = await repo.getOrCreate(userId, this.d.newId(), this.d.nowMs());
      const lines = cart.lines.filter((l) => !drop.has(l.id));
      if (lines.length === cart.lines.length) return;
      if (await repo.save({ ...cart, lines }, cart.version, this.d.nowMs())) return;
    }
  }
}

// --------------------------------------------------------------------------- promotions and tax

export class PromotionsAdapter implements PromotionsPort {
  constructor(private readonly svc: Late<EvaluatePromotions>) {}
  evaluate(input: Parameters<PromotionsPort["evaluate"]>[0]): ReturnType<PromotionsPort["evaluate"]> {
    return this.svc.get().execute(input);
  }
}

export class TaxAdapter implements TaxPort {
  constructor(private readonly svc: Late<QuoteOrderTax>) {}

  async quote(input: Parameters<TaxPort["quote"]>[0]): ReturnType<TaxPort["quote"]> {
    const r = await this.svc.get().execute({
      lines: input.lines.map((l) => ({ id: l.id, unitGross: l.unitGross, qty: l.qty, categoryCode: l.categoryCode })),
      orderDiscountPiastres: input.orderDiscount.amount,
    });
    if (r.kind !== "ok") throw new Error(`tax quote rejected: ${r.message}`);
    // The headline rate is the highest rate among the lines; per-line VAT is the exact figure.
    const vatBps = r.tax.lines.reduce((m, l) => (l.rateBps > m ? l.rateBps : m), 0n);
    return { lines: r.tax.lines.map((l) => ({ id: l.id, vat: l.vat })), vatBps };
  }
}

// --------------------------------------------------------------------------- inventory

const INVENTORY_METHOD: Readonly<Record<CheckoutMethod, string>> = {
  card: "CARD",
  apple_pay: "APPLE_PAY",
  meeza: "MEEZA",
  mobile_wallet: "WALLET",
  instapay: "INSTAPAY",
  fawry: "FAWRY",
  bnpl: "BNPL",
  cod: "COD",
};

export class InventoryAdapter implements InventoryPort {
  constructor(
    private readonly reserveStock: Late<ReserveStock>,
    private readonly claimReservation: Late<ClaimReservation>,
    private readonly releaseReservation: Late<ReleaseReservation>,
  ) {}

  async reserve(input: Parameters<InventoryPort["reserve"]>[0]): Promise<ReserveResult> {
    const r = await this.reserveStock.get().execute({
      orderGroupId: input.orderGroupId,
      userId: input.userId,
      paymentMethod: INVENTORY_METHOD[input.method],
      lines: input.lines.map((l) => ({ skuId: l.skuId, qty: l.qty })),
    });
    switch (r.kind) {
      case "reserved":
        return { kind: "reserved", reservationId: r.reservationId, expiresAtMs: Date.parse(r.expiresAt) };
      case "insufficient":
        return {
          kind: "insufficient",
          shortfalls: r.shortfalls.map((s) => ({ skuId: s.skuId, requested: s.requested, available: s.available })),
        };
      case "invalid":
        return { kind: "rejected", code: r.code };
      case "conflict":
        return { kind: "rejected", code: "reservation_conflict" };
      case "closed":
        return { kind: "rejected", code: `reservation_${r.reservationStatus.toLowerCase()}` };
    }
  }

  async claim(orderGroupId: string): Promise<ClaimResult> {
    const r = await this.claimReservation.get().execute({ orderGroupId });
    switch (r.status) {
      case "claimed":
      case "claimed_late":
      case "already_claimed":
        return { kind: r.status };
      case "unavailable":
        return { kind: "unavailable" };
      case "not_found":
      case "invalid_input":
        return { kind: "not_found" };
    }
  }

  async release(orderGroupId: string, reason: "payment_failed" | "cancelled" | "abandoned"): Promise<void> {
    const r = await this.releaseReservation.get().execute({ orderGroupId }, reason);
    if (r.status === "invalid_input") throw new Error("inventory release: invalid order group id");
  }

  async unclaim(orderGroupId: string, reason: "payment_failed" | "cancelled" | "abandoned"): Promise<void> {
    const r = await this.releaseReservation.get().unclaim({ orderGroupId }, reason);
    if (r.status === "invalid_input") throw new Error("inventory unclaim: invalid order group id");
  }
}

// --------------------------------------------------------------------------- store credit

export class StoreCreditAdapter implements StoreCreditPort {
  constructor(
    private readonly holds: Late<CreditHolds>,
    private readonly store: Late<StoreCreditStore>,
  ) {}

  async balances(userId: string): ReturnType<StoreCreditPort["balances"]> {
    // Spendable at the holds service's own clock: expired lots are not planned (F-11).
    return subBalanceStates(await this.store.get().listLots(userId), this.holds.get().now());
  }

  async hold(input: Parameters<StoreCreditPort["hold"]>[0]): Promise<HoldResult> {
    const total = input.plan.reduce<bigint>((a, p) => a + p.amount.amount, 0n);
    const r = await this.holds
      .get()
      .hold({ userId: input.userId, ref: input.holdId, amount: money(total), ttlMs: input.ttlSeconds * 1000 });
    // The store plans the lots itself (soonest expiry first, refund credit last), idempotent on the ref.
    return r.kind === "insufficient" ? { kind: "insufficient" } : { kind: "held", holdId: input.holdId };
  }

  async capture(input: { holdId: string; userId: string; orderEntryKey: string }): Promise<CaptureResult> {
    const r = await this.holds.get().capture({ userId: input.userId, ref: input.holdId, orderEntryKey: input.orderEntryKey });
    return { kind: r.kind };
  }

  async release(input: { holdId: string; userId: string }): Promise<void> {
    await this.holds.get().release(input.userId, input.holdId);
  }
}

// --------------------------------------------------------------------------- orders

export class OrdersAdapter implements OrdersIntakePort {
  constructor(private readonly place_: Late<PlaceOrders>) {}
  place(cmd: PlaceOrdersCommand): ReturnType<OrdersIntakePort["place"]> {
    return this.place_.get().execute(cmd);
  }
}

// --------------------------------------------------------------------------- payments

const PSP_METHODS: ReadonlySet<CheckoutMethod> = new Set(["card", "meeza", "apple_pay", "mobile_wallet", "instapay", "fawry"]);

export interface PaymentsAdapterDeps {
  readonly create: Late<CreatePaymentIntent>;
  readonly voidPayment: Late<VoidPayment>;
  readonly refundPayment: Late<RefundPayment>;
  /** Phone and email for the PSP payer block. No identity module exposes them yet: null is sent. */
  readonly payer?: (userId: string) => Promise<{ phoneE164: string | null; email: string | null }>;
}

type PspMethod = "card" | "meeza" | "apple_pay" | "mobile_wallet" | "instapay" | "fawry";

/**
 * Checkout's PaymentProviderPort over the payments module. Payments owns routing, failover and the
 * webhook endpoint; checkout learns the outcome from `payment.*` events (see PaymentEventsBridge),
 * so verifyWebhook here refuses everything: the checkout-owned webhook route cannot be fed forged
 * bodies through this adapter.
 */
export class PaymentsModuleProvider implements PaymentProviderPort {
  readonly provider = "payments_module";
  constructor(private readonly d: PaymentsAdapterDeps) {}

  async createIntent(input: Parameters<PaymentProviderPort["createIntent"]>[0]): Promise<CreateIntentResult> {
    if (!PSP_METHODS.has(input.method)) return { kind: "rejected", code: "method_not_psp" };
    const payer = (await this.d.payer?.(input.userId)) ?? { phoneE164: null, email: null };
    const r = await this.d.create.get().execute({
      orderGroupId: input.idempotencyKey,
      userId: input.userId,
      method: input.method as PspMethod,
      amount: input.amount.amount,
      currency: input.amount.currency,
      // Checkout does not pass the drop flag; the inventory pool plan already keeps drops out of Fawry.
      containsDropSku: false,
      payer: { userId: input.userId, ...payer },
    });
    if (r.kind === "created" || r.kind === "existing" || r.kind === "pending_unknown") {
      const a = r.intent.clientAction;
      return {
        kind: "created",
        intentId: r.intent.id,
        provider: r.intent.provider,
        clientAction: a === null ? { type: "none" } : mapAction(a),
      };
    }
    if (r.kind === "method_unavailable") return { kind: "rejected", code: `method_unavailable_${r.reason}` };
    if (r.kind === "declined") return { kind: "rejected", code: r.code };
    return { kind: "rejected", code: r.kind === "invalid" ? r.code : r.kind };
  }

  async voidIntent(intentId: string): ReturnType<PaymentProviderPort["voidIntent"]> {
    const r = await this.d.voidPayment.get().execute(intentId);
    if (r.kind === "ok") return { kind: "voided" };
    if (r.kind === "not_found") return { kind: "already_voided" };
    if (r.kind === "invalid_state" && (r.status === "SUCCEEDED" || r.status === "PARTIALLY_REFUNDED" || r.status === "REFUNDED")) {
      return { kind: "not_voidable_succeeded" };
    }
    if (r.kind === "invalid_state" && r.status === "VOIDED") return { kind: "already_voided" };
    throw new Error(`void failed: ${r.kind}`);
  }

  async refund(input: Parameters<PaymentProviderPort["refund"]>[0]): Promise<void> {
    const r = await this.d.refundPayment.get().execute({
      intentId: input.intentId,
      amount: input.amount.amount,
      idempotencyKey: input.idempotencyKey,
      reason: "checkout_compensation",
    });
    if (r.kind === "failed" || r.kind === "not_found" || r.kind === "not_refundable" || r.kind === "exceeds_captured" || r.kind === "invalid_amount") {
      throw new Error(`refund failed: ${r.kind}`);
    }
  }

  verifyWebhook(): ReturnType<PaymentProviderPort["verifyWebhook"]> {
    return { ok: false, reason: "unknown_provider" };
  }
}

function mapAction(a: PspClientAction): ClientAction {
  switch (a.kind) {
    case "redirect":
    case "iframe":
      return { type: "redirect", url: a.url };
    case "reference_code":
      return { type: "fawry_reference", reference: a.reference, expiresAtMs: a.expires_at_ms };
    case "apple_pay_session":
      return { type: "sdk", sdk: "apple_pay", token: a.session_url };
    case "wallet_prompt":
      return { type: "sdk", sdk: "wallet_prompt", token: a.message_code };
    case "qr_payload":
      return { type: "sdk", sdk: "instapay_qr", token: a.payload };
  }
}

export class PaymentsRegistry implements PaymentRegistry {
  constructor(private readonly provider: PaymentProviderPort) {}
  forMethod(method: CheckoutMethod): PaymentProviderPort | null {
    return PSP_METHODS.has(method) ? this.provider : null;
  }
  byName(name: string): PaymentProviderPort | null {
    return name.length > 0 ? this.provider : null;
  }
}

export type { AgePolicyPort, Money };
