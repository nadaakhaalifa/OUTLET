/**
 * One-page multi-store checkout (spec §7). Pure model, ports and in-memory fakes. Money is integer
 * piastres (bigint). The server quote is the source of truth: nothing here invents a price, a
 * saving, an installment or an availability. No card data ever enters this module.
 */
import { PortError, type PortFailure } from "../worlds/model";

export { PortError };
export type { PortFailure };

export interface LocalizedText {
  readonly ar: string;
  readonly en: string;
}
export type Lang = "ar" | "en";
export function pickText(t: LocalizedText, lang: Lang): string {
  return lang === "en" ? t.en : t.ar;
}

/* ---- address (governorate -> city -> street) ---- */

export interface City {
  readonly id: string;
  readonly name: LocalizedText;
}
export interface Governorate {
  readonly id: string;
  readonly name: LocalizedText;
  readonly cities: readonly City[];
}
export interface GeoPin {
  readonly lat: number;
  readonly lng: number;
}
export interface AddressDraft {
  readonly governorateId: string | null;
  readonly cityId: string | null;
  readonly street: string;
  readonly building: string;
  readonly floor: string;
  readonly apartment: string;
  readonly landmark: string;
  readonly pin: GeoPin | null;
}
export const EMPTY_ADDRESS: AddressDraft = {
  governorateId: null, cityId: null, street: "", building: "", floor: "", apartment: "", landmark: "", pin: null,
};

export type AddressField = "governorate" | "city" | "street" | "building" | "landmark" | "pin";

/** Landmark and map pin are required for COD (spec §20.7); `codSelected` tightens validation. */
export function validateAddress(a: AddressDraft, coverage: readonly Governorate[], codSelected: boolean): readonly AddressField[] {
  const errors: AddressField[] = [];
  const gov = coverage.find((g) => g.id === a.governorateId);
  if (gov === undefined) errors.push("governorate");
  else if (!gov.cities.some((c) => c.id === a.cityId)) errors.push("city");
  if (a.street.trim().length === 0) errors.push("street");
  if (a.building.trim().length === 0) errors.push("building");
  if (codSelected) {
    if (a.landmark.trim().length === 0) errors.push("landmark");
    if (a.pin === null) errors.push("pin");
  }
  return errors;
}

export function citiesFor(coverage: readonly Governorate[], governorateId: string | null): readonly City[] {
  return coverage.find((g) => g.id === governorateId)?.cities ?? [];
}

/** Changing the governorate clears a city that no longer belongs to it. */
export function setGovernorate(a: AddressDraft, coverage: readonly Governorate[], id: string): AddressDraft {
  const stillValid = citiesFor(coverage, id).some((c) => c.id === a.cityId);
  return { ...a, governorateId: id, cityId: stillValid ? a.cityId : null };
}

/* ---- quote (server authoritative) ---- */

export interface QuoteLine {
  readonly lineId: string;
  readonly title: string;
  readonly qty: number;
  readonly unitPrice: bigint;
  /** Price the shopper last saw and confirmed (bag or previous quote). Drives the re-confirmation delta. */
  readonly confirmedUnitPrice: bigint;
  /** Verified reference price (spec §9). Null means no evidence: no saving is ever shown. */
  readonly verifiedReferencePrice: bigint | null;
}

export interface DeliveryOption {
  readonly id: string;
  readonly name: LocalizedText;
  readonly fee: bigint;
  readonly etaDays: number;
}

export interface QuoteShipment {
  readonly id: string;
  readonly storeName: string;
  readonly lines: readonly QuoteLine[];
  readonly deliveryOptions: readonly DeliveryOption[];
}

export type PaymentKind = "card" | "apple_pay" | "meeza" | "wallet" | "instapay" | "fawry" | "installment" | "cod";

export interface InstallmentQuote {
  readonly providerName: string;
  readonly monthly: bigint;
  readonly tenorMonths: number;
  readonly adminFee: bigint;
  readonly termsUrl: string;
}

export interface PaymentMethod {
  readonly id: string;
  readonly kind: PaymentKind;
  readonly name: LocalizedText;
  /** Kill-switched methods are never rendered (spec A2.12). */
  readonly killSwitched: boolean;
  readonly available: boolean;
  /** Server reason shown when `available` is false (for COD this is the risk or cap explanation). */
  readonly unavailableReason: LocalizedText | null;
  /** Present only when the provider's quote API returned it. Never computed here. */
  readonly installment: InstallmentQuote | null;
  /** Hint such as the Fawry payment window; server supplied. */
  readonly note: LocalizedText | null;
}

export interface QuoteVoucher {
  readonly code: string;
  readonly discount: bigint;
  readonly applied: boolean;
}

export interface QuoteFee {
  readonly id: string;
  readonly name: LocalizedText;
  readonly amount: bigint;
}

export interface CheckoutQuote {
  readonly quoteId: string;
  readonly shipments: readonly QuoteShipment[];
  readonly paymentMethods: readonly PaymentMethod[];
  readonly vouchers: readonly QuoteVoucher[];
  /** Fees other than delivery (every fee appears on first render: no drip pricing). */
  readonly fees: readonly QuoteFee[];
  readonly storeCreditBalance: bigint;
  readonly priceLockSeconds: number;
  readonly isPlusMember: boolean;
  /** Server-computed delivery saving if the shopper were a Plus member; null when none or already a member. Never computed in the app. */
  readonly plusSavings: bigint | null;
  readonly coverage: readonly Governorate[];
}

/* ---- selection and totals ---- */

export interface CheckoutSelection {
  readonly address: AddressDraft;
  /** shipmentId -> deliveryOptionId */
  readonly delivery: Readonly<Record<string, string>>;
  readonly paymentMethodId: string | null;
  readonly voucherCodes: readonly string[];
  readonly useStoreCredit: boolean;
}

export function initialSelection(q: CheckoutQuote): CheckoutSelection {
  const delivery: Record<string, string> = {};
  for (const s of q.shipments) {
    const cheapest = [...s.deliveryOptions].sort((a, b) => (a.fee < b.fee ? -1 : a.fee > b.fee ? 1 : a.id.localeCompare(b.id)))[0];
    if (cheapest !== undefined) delivery[s.id] = cheapest.id;
  }
  return { address: EMPTY_ADDRESS, delivery, paymentMethodId: null, voucherCodes: [], useStoreCredit: false };
}

/** Methods the shopper can see: kill-switched ones are removed, unavailable ones stay with a reason. */
export function visiblePaymentMethods(q: CheckoutQuote): readonly PaymentMethod[] {
  return q.paymentMethods.filter((m) => !m.killSwitched);
}

export interface InstallmentLine {
  readonly providerName: string;
  readonly monthly: bigint;
  readonly tenorMonths: number;
  readonly adminFee: bigint;
  readonly termsUrl: string;
  /** Always true: the number is the provider's estimate, never HAUL's own credit decision (spec B3). */
  readonly estimatedFromProvider: true;
}

export function installmentLine(m: PaymentMethod): InstallmentLine | null {
  if (m.installment === null) return null;
  return { ...m.installment, estimatedFromProvider: true };
}

export interface ShipmentTotal {
  readonly shipmentId: string;
  readonly storeName: string;
  readonly merchandise: bigint;
  readonly delivery: bigint;
  readonly deliveryOptionId: string | null;
}

export interface Totals {
  readonly shipments: readonly ShipmentTotal[];
  readonly merchandise: bigint;
  readonly delivery: bigint;
  readonly otherFees: bigint;
  readonly voucherDiscount: bigint;
  readonly totalBeforeCredit: bigint;
  readonly storeCreditApplied: bigint;
  /** Remainder charged to the external payment method (split tender). */
  readonly payable: bigint;
  /** Sum of confirmed-vs-current line differences. Positive means the price rose since confirmation. */
  readonly priceDelta: bigint;
  /** Verified savings only (spec §7 step 5). Zero means the "You saved" line is not shown. */
  readonly verifiedSavings: bigint;
}

export function computeTotals(q: CheckoutQuote, sel: CheckoutSelection): Totals {
  let merchandise = 0n;
  let delivery = 0n;
  let priceDelta = 0n;
  let verifiedSavings = 0n;
  const shipments: ShipmentTotal[] = q.shipments.map((s) => {
    let m = 0n;
    for (const l of s.lines) {
      const qty = BigInt(l.qty);
      m += l.unitPrice * qty;
      priceDelta += (l.unitPrice - l.confirmedUnitPrice) * qty;
      if (l.verifiedReferencePrice !== null && l.verifiedReferencePrice > l.unitPrice) {
        verifiedSavings += (l.verifiedReferencePrice - l.unitPrice) * qty;
      }
    }
    const opt = s.deliveryOptions.find((o) => o.id === sel.delivery[s.id]);
    // Plus members and other waivers arrive as a zero fee in the option itself; the client never zeroes a fee.
    const fee = opt?.fee ?? 0n;
    merchandise += m;
    delivery += fee;
    return { shipmentId: s.id, storeName: s.storeName, merchandise: m, delivery: fee, deliveryOptionId: opt?.id ?? null };
  });
  const otherFees = q.fees.reduce((n, f) => n + f.amount, 0n);
  const voucherRaw = q.vouchers.filter((v) => v.applied && sel.voucherCodes.includes(v.code)).reduce((n, v) => n + v.discount, 0n);
  const gross = merchandise + delivery + otherFees;
  const voucherDiscount = voucherRaw > gross ? gross : voucherRaw;
  const totalBeforeCredit = gross - voucherDiscount;
  const credit = sel.useStoreCredit ? (q.storeCreditBalance < totalBeforeCredit ? q.storeCreditBalance : totalBeforeCredit) : 0n;
  return {
    shipments, merchandise, delivery, otherFees, voucherDiscount, totalBeforeCredit,
    storeCreditApplied: credit, payable: totalBeforeCredit - credit, priceDelta, verifiedSavings,
  };
}

export type PlaceBlocker =
  | "address" | "delivery" | "paymentMethod" | "methodUnavailable" | "reconfirm" | "emptyBag";

export function placeBlockers(q: CheckoutQuote, sel: CheckoutSelection, reconfirmedDelta: bigint | null): readonly PlaceBlocker[] {
  const out: PlaceBlocker[] = [];
  const totals = computeTotals(q, sel);
  if (q.shipments.every((s) => s.lines.length === 0)) out.push("emptyBag");
  const method = visiblePaymentMethods(q).find((m) => m.id === sel.paymentMethodId);
  const needsExternal = totals.payable > 0n;
  if (validateAddress(sel.address, q.coverage, method?.kind === "cod").length > 0) out.push("address");
  if (q.shipments.some((s) => s.lines.length > 0 && (totals.shipments.find((t) => t.shipmentId === s.id)?.deliveryOptionId ?? null) === null)) out.push("delivery");
  if (needsExternal && method === undefined) out.push("paymentMethod");
  else if (needsExternal && method !== undefined && !method.available) out.push("methodUnavailable");
  if (totals.priceDelta !== 0n && reconfirmedDelta !== totals.priceDelta) out.push("reconfirm");
  return out;
}

/** The re-confirmation applies to one exact delta; if the delta moves again the shopper is asked again. */
export function needsReconfirmation(totals: Totals, reconfirmedDelta: bigint | null): boolean {
  return totals.priceDelta !== 0n && reconfirmedDelta !== totals.priceDelta;
}

/* ---- idempotency (Idempotency-Key = client UUIDv7, once per attempt) ---- */

/** RFC 9562 UUIDv7 from a millisecond clock and 10 random bytes. Pure: callers inject both. */
export function uuidv7(nowMs: number, random: Uint8Array): string {
  if (random.length < 10) throw new Error("uuidv7 needs 10 random bytes");
  const b = new Uint8Array(16);
  const ts = BigInt(Math.max(0, Math.floor(nowMs)));
  for (let i = 0; i < 6; i += 1) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  for (let i = 0; i < 10; i += 1) b[6 + i] = random[i] ?? 0;
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface PlaceRequest {
  readonly quoteId: string;
  readonly address: AddressDraft;
  readonly delivery: Readonly<Record<string, string>>;
  readonly paymentMethodId: string | null;
  readonly voucherCodes: readonly string[];
  readonly useStoreCredit: boolean;
  /** Delta the shopper re-confirmed, so the server can refuse a stale confirmation. */
  readonly acceptedPriceDelta: bigint;
}

export function buildPlaceRequest(q: CheckoutQuote, sel: CheckoutSelection, totals: Totals): PlaceRequest {
  return {
    quoteId: q.quoteId,
    address: sel.address,
    delivery: sel.delivery,
    paymentMethodId: totals.payable > 0n ? sel.paymentMethodId : null,
    voucherCodes: [...sel.voucherCodes].sort(),
    useStoreCredit: sel.useStoreCredit,
    acceptedPriceDelta: totals.priceDelta,
  };
}

/** Stable fingerprint: the same key may only ever accompany the same request body (spec A2.5). */
export function requestFingerprint(r: PlaceRequest): string {
  const d = Object.entries(r.delivery).sort(([a], [b]) => a.localeCompare(b));
  const a = r.address;
  return JSON.stringify([
    r.quoteId, a.governorateId, a.cityId, a.street, a.building, a.floor, a.apartment, a.landmark, a.pin?.lat ?? null, a.pin?.lng ?? null,
    d, r.paymentMethodId, r.voucherCodes, r.useStoreCredit, r.acceptedPriceDelta.toString(),
  ]);
}

export type ClientAction =
  | { readonly type: "none" }
  | { readonly type: "redirect"; readonly url: string }
  | { readonly type: "sdk_sheet"; readonly sessionToken: string }
  | { readonly type: "reference_code"; readonly code: string; readonly expiresAt: string };

export type PlaceResult =
  | { readonly kind: "placed"; readonly orderGroupId: string }
  | { readonly kind: "requires_action"; readonly orderGroupId: string; readonly action: ClientAction }
  | { readonly kind: "price_changed"; readonly quote: CheckoutQuote }
  | { readonly kind: "rejected"; readonly reason: LocalizedText; readonly retryable: boolean };

export type OrderGroupStatus = "pending_payment" | "paid" | "confirmed_cod" | "failed" | "expired";

export interface CheckoutPort {
  quote(selectionHint: { readonly address: AddressDraft }): Promise<CheckoutQuote>;
  /** `admissionToken` is the drop waiting-room token (memory handoff), sent only in a header by the real client. */
  place(request: PlaceRequest, idempotencyKey: string, admissionToken?: string | null): Promise<PlaceResult>;
  /** The server is the source of truth for the outcome (webhook may land before or after the redirect). */
  orderGroupStatus(orderGroupId: string): Promise<OrderGroupStatus>;
}

export type PaymentLaunchOutcome = "succeeded" | "cancelled" | "failed" | "pending";

/** Hosted page / native PSP SDK launcher. Card data is entered there and never reaches the app. */
export interface PaymentLauncherPort {
  launch(action: ClientAction): Promise<PaymentLaunchOutcome>;
}

export interface MapPinPort {
  pick(current: GeoPin | null): Promise<GeoPin | null>;
}

/* ---- submission state machine (duplicate-tap protection) ---- */

export type Submission =
  | { readonly status: "idle" }
  | { readonly status: "submitting"; readonly key: string; readonly fingerprint: string }
  | { readonly status: "awaitingPayment"; readonly key: string; readonly fingerprint: string; readonly orderGroupId: string }
  | { readonly status: "done"; readonly orderGroupId: string; readonly cod: boolean }
  | { readonly status: "failed"; readonly key: string; readonly fingerprint: string; readonly reason: LocalizedText | null; readonly retryable: boolean };

export type SubmitStep =
  | { readonly start: false; readonly submission: Submission }
  | { readonly start: true; readonly submission: Submission; readonly key: string };

/**
 * A tap while an attempt is in flight (or awaiting payment) starts nothing. A retry of a retryable
 * failure with an identical request reuses the key (safe replay); any other new attempt gets a new key.
 */
export function beginSubmit(s: Submission, fingerprint: string, newKey: () => string): SubmitStep {
  if (s.status === "submitting" || s.status === "awaitingPayment" || s.status === "done") return { start: false, submission: s };
  if (s.status === "failed" && s.retryable && s.fingerprint === fingerprint) {
    return { start: true, key: s.key, submission: { status: "submitting", key: s.key, fingerprint } };
  }
  const key = newKey();
  return { start: true, key, submission: { status: "submitting", key, fingerprint } };
}

export interface Outcome {
  readonly submission: Submission;
  /** A fresh quote the shopper must re-confirm; the submission returns to idle. */
  readonly quote: CheckoutQuote | null;
}

export function applyPlaceResult(prev: Extract<Submission, { status: "submitting" }>, r: PlaceResult, codSelected: boolean): Outcome {
  switch (r.kind) {
    case "placed":
      return { submission: { status: "done", orderGroupId: r.orderGroupId, cod: codSelected }, quote: null };
    case "requires_action":
      return { submission: { status: "awaitingPayment", key: prev.key, fingerprint: prev.fingerprint, orderGroupId: r.orderGroupId }, quote: null };
    case "price_changed":
      return { submission: { status: "idle" }, quote: r.quote };
    case "rejected":
      return { submission: { status: "failed", key: prev.key, fingerprint: prev.fingerprint, reason: r.reason, retryable: r.retryable }, quote: null };
  }
}

/** Network drop or timeout: the same key is retried so a replay can never double-charge. */
export function applyPlaceFailure(prev: Extract<Submission, { status: "submitting" }>): Submission {
  return { status: "failed", key: prev.key, fingerprint: prev.fingerprint, reason: null, retryable: true };
}

export function applyOrderStatus(prev: Extract<Submission, { status: "awaitingPayment" }>, st: OrderGroupStatus): Submission {
  if (st === "paid") return { status: "done", orderGroupId: prev.orderGroupId, cod: false };
  if (st === "confirmed_cod") return { status: "done", orderGroupId: prev.orderGroupId, cod: true };
  if (st === "pending_payment") return prev;
  return { status: "failed", key: prev.key, fingerprint: prev.fingerprint, reason: null, retryable: false };
}

export type CheckoutScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly quote: CheckoutQuote };

export function checkoutFailureState(e: unknown): CheckoutScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

/* ---- fakes (development and tests only; synthetic data) ---- */

export const FIXTURE_COVERAGE: readonly Governorate[] = [
  { id: "cairo", name: { ar: "القاهرة", en: "Cairo" }, cities: [
    { id: "nasr", name: { ar: "مدينة نصر", en: "Nasr City" } },
    { id: "maadi", name: { ar: "المعادي", en: "Maadi" } },
  ] },
  { id: "giza", name: { ar: "الجيزة", en: "Giza" }, cities: [{ id: "dokki", name: { ar: "الدقي", en: "Dokki" } }] },
];

export const FIXTURE_QUOTE: CheckoutQuote = {
  quoteId: "q-1",
  priceLockSeconds: 600,
  isPlusMember: false,
  plusSavings: 6_500n,
  storeCreditBalance: 15_000n,
  coverage: FIXTURE_COVERAGE,
  fees: [],
  vouchers: [{ code: "WELCOME", discount: 5_000n, applied: true }],
  shipments: [
    {
      id: "sh1", storeName: "Cairo Denim",
      lines: [
        { lineId: "l1", title: "Straight jeans", qty: 1, unitPrice: 119_000n, confirmedUnitPrice: 119_000n, verifiedReferencePrice: 149_000n },
        { lineId: "l2", title: "Denim jacket", qty: 1, unitPrice: 76_000n, confirmedUnitPrice: 70_000n, verifiedReferencePrice: null },
      ],
      deliveryOptions: [
        { id: "std", name: { ar: "توصيل عادي", en: "Standard delivery" }, fee: 0n, etaDays: 3 },
        { id: "fast", name: { ar: "توصيل سريع", en: "Fast delivery" }, fee: 6_000n, etaDays: 1 },
      ],
    },
    {
      id: "sh2", storeName: "Atlas Sport",
      lines: [{ lineId: "l3", title: "Sport socks", qty: 2, unitPrice: 9_000n, confirmedUnitPrice: 9_000n, verifiedReferencePrice: null }],
      deliveryOptions: [{ id: "std", name: { ar: "توصيل عادي", en: "Standard delivery" }, fee: 4_500n, etaDays: 4 }],
    },
  ],
  paymentMethods: [
    { id: "card", kind: "card", name: { ar: "بطاقة", en: "Card" }, killSwitched: false, available: true, unavailableReason: null, installment: null, note: null },
    { id: "valu", kind: "installment", name: { ar: "تقسيط valU", en: "valU installments" }, killSwitched: false, available: true, unavailableReason: null,
      installment: { providerName: "valU", monthly: 41_000n, tenorMonths: 6, adminFee: 2_000n, termsUrl: "https://example.invalid/valu-terms" }, note: null },
    { id: "cod", kind: "cod", name: { ar: "الدفع عند الاستلام", en: "Cash on delivery" }, killSwitched: false, available: false,
      unavailableReason: { ar: "الدفع عند الاستلام غير متاح لهذا الطلب. الحد الأقصى لأول طلب 1500 ج.م", en: "Cash on delivery is not available for this order. First orders are capped at 1,500 EGP." },
      installment: null, note: null },
    { id: "fawry", kind: "fawry", name: { ar: "فوري", en: "Fawry" }, killSwitched: true, available: true, unavailableReason: null, installment: null, note: null },
  ],
};

export class InMemoryCheckoutPort implements CheckoutPort {
  placeCalls: Array<{ request: PlaceRequest; key: string; admission: string | null }> = [];
  private readonly results = new Map<string, PlaceResult>();
  private statuses: OrderGroupStatus[] = ["paid"];
  constructor(private readonly q: CheckoutQuote = FIXTURE_QUOTE, private failure: PortFailure | null = null, private placeResult: PlaceResult = { kind: "placed", orderGroupId: "og-1" }) {}
  setFailure(f: PortFailure | null): void { this.failure = f; }
  setPlaceResult(r: PlaceResult): void { this.placeResult = r; }
  setStatuses(s: OrderGroupStatus[]): void { this.statuses = s; }
  private check(): void { if (this.failure !== null) throw new PortError(this.failure); }
  async quote(): Promise<CheckoutQuote> { this.check(); return this.q; }
  async place(request: PlaceRequest, key: string, admissionToken: string | null = null): Promise<PlaceResult> {
    this.check();
    this.placeCalls.push({ request, key, admission: admissionToken });
    // Same key replays the stored response: the contract of the server idempotency store.
    const prior = this.results.get(key);
    if (prior !== undefined) return prior;
    this.results.set(key, this.placeResult);
    return this.placeResult;
  }
  async orderGroupStatus(): Promise<OrderGroupStatus> {
    this.check();
    return this.statuses.length > 1 ? (this.statuses.shift() ?? "pending_payment") : (this.statuses[0] ?? "pending_payment");
  }
}

export class FakePaymentLauncher implements PaymentLauncherPort {
  launched: ClientAction[] = [];
  constructor(private outcome: PaymentLaunchOutcome = "succeeded") {}
  setOutcome(o: PaymentLaunchOutcome): void { this.outcome = o; }
  async launch(action: ClientAction): Promise<PaymentLaunchOutcome> {
    this.launched.push(action);
    return this.outcome;
  }
}

export class FakeMapPin implements MapPinPort {
  constructor(private readonly result: GeoPin | null = { lat: 30.0444, lng: 31.2357 }) {}
  async pick(): Promise<GeoPin | null> { return this.result; }
}
