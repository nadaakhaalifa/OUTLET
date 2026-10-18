import { ApiError, ContractDriftError, dataOf, type schemas } from "../../services/api-client";
import { guard, money, ms, pick, toMoney, toPortError, bilingual, type AdapterContext } from "../../services/wire";
import type {
  AddressDraft, CheckoutPort, CheckoutQuote, ClientAction, OrderGroupStatus, PaymentKind, PaymentMethod, PlaceRequest, PlaceResult,
  QuoteShipment,
} from "./model";

const KIND: Readonly<Record<schemas.PaymentMethodCode, PaymentKind>> = {
  card: "card", apple_pay: "apple_pay", meeza: "meeza", mobile_wallet: "wallet", instapay: "instapay", fawry: "fawry", bnpl: "installment", cod: "cod",
};
/** The quote carries method codes only, no display names (gap): names come from this table until the API sends them. */
const NAMES: Readonly<Record<schemas.PaymentMethodCode, { ar: string; en: string }>> = {
  card: { ar: "بطاقة", en: "Card" }, apple_pay: { ar: "Apple Pay", en: "Apple Pay" }, meeza: { ar: "ميزة", en: "Meeza" },
  mobile_wallet: { ar: "محفظة موبايل", en: "Mobile wallet" }, instapay: { ar: "إنستا باي", en: "InstaPay" },
  fawry: { ar: "فوري", en: "Fawry" }, bnpl: { ar: "تقسيط", en: "Installments" }, cod: { ar: "الدفع عند الاستلام", en: "Cash on delivery" },
};
const STANDARD_DELIVERY = { ar: "توصيل", en: "Delivery" } as const;
const STANDARD_OPTION = "standard";

function matches(a: schemas.Address, d: AddressDraft): boolean {
  return a.governorate_code === d.governorateId && a.city_district_code === d.cityId && a.street === d.street && a.building === d.building;
}

interface Cached {
  readonly quote: schemas.Quote;
  readonly addressId: string;
  readonly storeCreditBalance: bigint;
}

/**
 * /v1/checkout/quote and /v1/checkout. Gaps (docs/plan/api-client-gap.md): the quote has no delivery options,
 * vouchers list, line titles, coverage table or credit balance, so those are composed from the cart and wallet
 * where possible and left empty otherwise; nothing is invented.
 */
export class ApiCheckoutPort implements CheckoutPort {
  private cache: Cached | null = null;
  constructor(private readonly ctx: AdapterContext) {}

  /** Uses a saved address matching the draft. Creating one needs recipient name and phone, which the draft lacks (gap). */
  private async addressId(draft: AddressDraft): Promise<string> {
    const addrs = dataOf(await this.ctx.client.listAddresses());
    const found = addrs.items.find((a) => matches(a, draft));
    if (found === undefined) throw new Error("unsupported by the API contract: create address from AddressDraft (needs recipient_name and phone_e164)");
    return found.id;
  }

  private async creditBalance(): Promise<bigint> {
    try {
      return money(dataOf(await this.ctx.client.getWallet()).total);
    } catch (e) {
      // A wallet that breaks the contract must not block checkout: no credit is offered. Reported, not hidden.
      if (e instanceof ContractDriftError) {
        this.ctx.onDrift?.(e);
        return 0n;
      }
      throw e;
    }
  }

  quote(hint: { readonly address: AddressDraft }): Promise<CheckoutQuote> {
    return guard(async () => {
      const addressId = await this.addressId(hint.address);
      const cart = dataOf(await this.ctx.client.getCart());
      const lineIds = cart.groups.filter((g) => g.status === "open").flatMap((g) => g.lines.filter((l) => l.availability === "available" && l.saved_for_later !== true).map((l) => l.id));
      const q = dataOf(await this.ctx.client.quoteCheckout({ body: { address_id: addressId, cart_line_ids: lineIds } }));
      const credit = await this.creditBalance();
      this.cache = { quote: q, addressId, storeCreditBalance: credit };
      return this.mapQuote(q, cart, credit);
    });
  }

  private mapQuote(q: schemas.Quote, cart: schemas.Cart, credit: bigint): CheckoutQuote {
    const lang = this.ctx.locale();
    const changes = new Map((q.price_changes ?? []).map((c) => [c.sku_id, c]));
    const shipments: QuoteShipment[] = q.groups.map((g) => {
      const cg = cart.groups.find((x) => x.store.id === g.store_id);
      return {
        id: g.store_id,
        storeName: cg !== undefined ? pick(cg.store.name, lang) : "",
        lines: (cg?.lines ?? [])
          .filter((l) => l.availability === "available" && l.saved_for_later !== true)
          .map((l) => ({
            lineId: l.id,
            title: pick(l.title, lang),
            qty: l.qty,
            unitPrice: money(l.unit_price),
            confirmedUnitPrice: changes.has(l.sku_id) ? money(changes.get(l.sku_id)?.from ?? l.unit_price) : money(l.unit_price),
            verifiedReferencePrice: null,
          })),
        deliveryOptions: [{ id: STANDARD_OPTION, name: STANDARD_DELIVERY, fee: money(g.shipping_fee), etaDays: 0 }],
      };
    });
    const methods: PaymentMethod[] = q.payment_methods.map((m) => ({
      id: m.method,
      kind: KIND[m.method],
      name: NAMES[m.method],
      killSwitched: false,
      available: m.available,
      unavailableReason: m.reason_code !== undefined ? { ar: m.reason_code, en: m.reason_code } : null,
      installment:
        m.installment_quote !== undefined
          ? {
              providerName: m.installment_quote.provider_name,
              monthly: money(m.installment_quote.monthly_amount),
              tenorMonths: m.installment_quote.tenor_months,
              adminFee: m.installment_quote.admin_fees !== undefined ? money(m.installment_quote.admin_fees) : 0n,
              termsUrl: m.installment_quote.terms_url,
            }
          : null,
      note: null,
    }));
    const lockEnd = q.price_lock_expires_at ?? q.expires_at;
    return {
      quoteId: q.quote_id,
      shipments,
      paymentMethods: methods,
      vouchers: [],
      fees: q.fees.map((f) => ({ id: f.code, name: bilingual(f.label), amount: money(f.amount) })),
      storeCreditBalance: credit,
      priceLockSeconds: Math.max(0, Math.floor((ms(lockEnd) - this.ctx.nowMs()) / 1000)),
      isPlusMember: cart.groups.some((g) => g.free_delivery.plus_member === true),
      plusSavings: q.plus_savings !== undefined && q.plus_savings !== null ? money(q.plus_savings) : null,
      coverage: [],
    };
  }

  async place(request: PlaceRequest, idempotencyKey: string, admissionToken?: string | null): Promise<PlaceResult> {
    try {
      const cached = this.cache;
      if (cached === null || cached.quote.quote_id !== request.quoteId) throw new Error("no quote to place: call quote() first");
      if (request.paymentMethodId === null) throw new Error("payment method required");
      const method = cached.quote.payment_methods.find((m) => m.method === request.paymentMethodId);
      if (method === undefined) throw new Error("payment method not in quote");
      const credit = request.useStoreCredit ? (cached.storeCreditBalance < money(cached.quote.total_payable) ? cached.storeCreditBalance : money(cached.quote.total_payable)) : 0n;
      const res = dataOf(
        await this.ctx.client.createCheckout(
          {
            body: {
              quote_id: request.quoteId,
              address_id: cached.addressId,
              payment_method: method.method,
              ...(credit > 0n ? { store_credit_amount: toMoney(credit) } : {}),
              ...(request.voucherCodes.length > 0 ? { voucher_codes: [...request.voucherCodes] } : {}),
              expected_total: cached.quote.total_payable,
              ...(request.acceptedPriceDelta !== 0n ? { confirm_price_changes: true } : {}),
              ...(admissionToken !== undefined && admissionToken !== null ? { admission_token: admissionToken } : {}),
            },
          },
          { idempotencyKey },
        ),
      );
      const action = this.mapAction(res.client_action);
      const id = res.order_group.id;
      return action === null ? { kind: "placed", orderGroupId: id } : { kind: "requires_action", orderGroupId: id, action };
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "price_changed") {
          const fresh = await this.quote({ address: this.lastDraftOrThrow(request) });
          return { kind: "price_changed", quote: fresh };
        }
        const text = bilingual({ ar: e.problem.detail ?? e.problem.title });
        return { kind: "rejected", reason: text, retryable: e.status >= 500 || e.status === 429 };
      }
      throw toPortError(e);
    }
  }

  private lastDraftOrThrow(request: PlaceRequest): AddressDraft {
    return request.address;
  }

  /** null = nothing for the app to launch (COD confirmation or already-paid orders are placed). */
  private mapAction(a: schemas.ClientAction): ClientAction | null {
    switch (a.type) {
      case "none":
      case "cod_confirmation":
        return null;
      case "redirect":
      case "three_ds":
        return { type: "redirect", url: a.url };
      case "apple_pay_session":
        return { type: "sdk_sheet", sessionToken: a.merchant_session };
      case "fawry_reference":
        return { type: "reference_code", code: a.reference_code, expiresAt: a.expires_at };
      case "instapay_request":
        return { type: "reference_code", code: a.qr_payload, expiresAt: a.expires_at };
    }
  }

  orderGroupStatus(orderGroupId: string): Promise<OrderGroupStatus> {
    return guard(async () => {
      const og = dataOf(await this.ctx.client.getOrderGroup({ path: { orderGroupId } }));
      switch (og.status) {
        case "created": case "reserved": case "payment_pending": return "pending_payment";
        case "paid": case "fulfilling": case "completed": return "paid";
        case "confirmed_cod": return "confirmed_cod";
        case "expired": return "expired";
        case "failed": case "cancelled": return "failed";
      }
    });
  }
}
