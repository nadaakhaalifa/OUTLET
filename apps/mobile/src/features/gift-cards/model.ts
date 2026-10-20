/**
 * Gift cards: purchase, redeem and group gift pots (spec §15.1, phase2/02, ADR-0003, ADR-0021).
 * Closed loop. Pure model, port and in-memory fake. Money is integer piastres (bigint).
 * Both capabilities sit behind kill switches (`gift_card_sales`, `gift_card_redemption`); when both
 * are off the whole feature is hidden. Redemption never reveals whether a code exists.
 */
import { PortError, type PortFailure } from "../worlds/model";

export { PortError };
export type { PortFailure };

export const MIN_CARD_AMOUNT = 10_000n; // 100 EGP
export const MAX_CARD_AMOUNT = 1_000_000n; // 10,000 EGP
export const MIN_CONTRIBUTION = 5_000n; // 50 EGP
/** Purchases above this need a purchaser aged 21+ (§B6). */
export const ADULT_PURCHASE_THRESHOLD = 500_000n; // 5,000 EGP
export const MAX_MESSAGE_LENGTH = 200;
export const MIN_CODE_LENGTH = 16;

export const GIFT_DESIGNS = ["birthday", "eid", "ramadan", "wedding", "newBaby", "graduation", "thankYou"] as const;
export type GiftDesign = (typeof GIFT_DESIGNS)[number];
export const DELIVERY_CHANNELS = ["whatsapp", "sms", "email", "inApp"] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

/** Server capability flags. Unknown means hidden: nothing renders until a load succeeds. */
export interface GiftCapabilities {
  readonly sales: boolean;
  readonly redemption: boolean;
}

export type GiftCardStatus = "PENDING_PAYMENT" | "ISSUED" | "DELIVERED" | "REDEEMED_PARTIAL" | "REDEEMED_FULL" | "EXPIRED" | "VOIDED";

export interface OwnedGiftCard {
  readonly id: string;
  readonly last4: string;
  readonly amount: bigint;
  readonly design: GiftDesign;
  readonly status: GiftCardStatus;
  readonly expiresAt: number | null;
  readonly scheduledDate: string | null;
}

export type PotStatus = "OPEN" | "CLOSED_FUNDED" | "CLOSED_UNFUNDED" | "REFUNDING" | "REFUNDED";

export interface GiftPot {
  readonly id: string;
  readonly title: string;
  readonly target: bigint;
  readonly raised: bigint;
  readonly closesOn: string;
  readonly status: PotStatus;
}

export interface GiftSnapshot {
  readonly capabilities: GiftCapabilities;
  /** Purchaser is 21 or over; decides the large-purchase gate. */
  readonly purchaserAdult: boolean;
  /** Default expiry shown at purchase, in months, from the server. */
  readonly expiryMonths: number;
  readonly cards: readonly OwnedGiftCard[];
  readonly pots: readonly GiftPot[];
}

export interface PurchaseDraft {
  readonly design: GiftDesign;
  readonly amountText: string;
  readonly message: string;
  readonly channel: DeliveryChannel;
  readonly recipientContact: string;
  /** "YYYY-MM-DD" in Cairo time, or empty for immediate delivery. */
  readonly scheduleDate: string;
}

export interface PurchaseRequest {
  readonly design: GiftDesign;
  readonly amount: bigint;
  readonly message: string;
  readonly channel: DeliveryChannel;
  readonly recipientContact: string | null;
  readonly scheduledDate: string | null;
}

export type RedeemOutcome =
  | { readonly kind: "redeemed"; readonly amount: bigint }
  /** One answer for wrong and unknown codes. `remainingAttempts` is the server's count. */
  | { readonly kind: "invalid"; readonly remainingAttempts: number | null }
  | { readonly kind: "rateLimited"; readonly retryAfterSeconds: number | null }
  | { readonly kind: "disabled" };

export type PurchaseOutcome =
  | { readonly kind: "created"; readonly cardId: string }
  | { readonly kind: "disabled" }
  | { readonly kind: "ageGate" }
  | { readonly kind: "rateLimited" };

export interface GiftCardsPort {
  load(): Promise<GiftSnapshot>;
  purchase(req: PurchaseRequest, idempotencyKey: string): Promise<PurchaseOutcome>;
  redeem(normalisedCode: string, idempotencyKey: string): Promise<RedeemOutcome>;
  voidCard(cardId: string, idempotencyKey: string): Promise<void>;
  createPot(target: bigint, closesOn: string, title: string, idempotencyKey: string): Promise<void>;
  contribute(potId: string, amount: bigint, idempotencyKey: string): Promise<void>;
}

/* ---- visibility ---- */

export type GiftVisibility = { readonly visible: false } | { readonly visible: true; readonly purchase: boolean; readonly redeem: boolean };

export function giftVisibility(c: GiftCapabilities | null): GiftVisibility {
  if (c === null || (!c.sales && !c.redemption)) return { visible: false };
  return { visible: true, purchase: c.sales, redeem: c.redemption };
}

/* ---- amounts ---- */

const EASTERN_DIGITS = "٠١٢٣٤٥٦٧٨٩";

function asciiDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(EASTERN_DIGITS.indexOf(d))).replace(/[,٬\s]/g, "");
}

/** Whole EGP only, Western or Eastern digits, to piastres. Null when not a plain positive integer. */
export function parseAmountEgp(text: string): bigint | null {
  const t = asciiDigits(text.trim());
  if (!/^[0-9]{1,7}$/.test(t)) return null;
  const v = BigInt(t) * 100n;
  return v > 0n ? v : null;
}

export type PurchaseError =
  | "amountInvalid" | "amountTooLow" | "amountTooHigh" | "needsAdult" | "messageTooLong"
  | "contactRequired" | "contactInvalid" | "scheduleInvalid" | "schedulePast" | "scheduleTooFar";

/** Cairo calendar date "YYYY-MM-DD" for an instant. */
export function cairoDateKey(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  return parts;
}

function validDateKey(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m === null) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

function addDays(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const MAX_SCHEDULE_DAYS = 365;

export function validatePurchase(d: PurchaseDraft, snap: Pick<GiftSnapshot, "purchaserAdult">, nowMs: number): readonly PurchaseError[] {
  const errors: PurchaseError[] = [];
  const amount = parseAmountEgp(d.amountText);
  if (amount === null) errors.push("amountInvalid");
  else if (amount < MIN_CARD_AMOUNT) errors.push("amountTooLow");
  else if (amount > MAX_CARD_AMOUNT) errors.push("amountTooHigh");
  else if (amount > ADULT_PURCHASE_THRESHOLD && !snap.purchaserAdult) errors.push("needsAdult");
  if (d.message.length > MAX_MESSAGE_LENGTH) errors.push("messageTooLong");
  if (d.channel !== "inApp") {
    const c = d.recipientContact.trim();
    if (c.length === 0) errors.push("contactRequired");
    else if (d.channel === "email" ? !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c) : !/^\+?[0-9]{10,15}$/.test(asciiDigits(c))) errors.push("contactInvalid");
  }
  const sched = d.scheduleDate.trim();
  if (sched.length > 0) {
    const today = cairoDateKey(nowMs);
    if (!validDateKey(sched)) errors.push("scheduleInvalid");
    else if (sched < today) errors.push("schedulePast");
    else if (sched > addDays(today, MAX_SCHEDULE_DAYS)) errors.push("scheduleTooFar");
  }
  return errors;
}

export function buildPurchaseRequest(d: PurchaseDraft): PurchaseRequest {
  const amount = parseAmountEgp(d.amountText);
  if (amount === null) throw new Error("invalid amount: validate before building the request");
  return {
    design: d.design,
    amount,
    message: d.message.trim(),
    channel: d.channel,
    recipientContact: d.channel === "inApp" ? null : d.recipientContact.trim(),
    scheduledDate: d.scheduleDate.trim().length === 0 ? null : d.scheduleDate.trim(),
  };
}

/** Expiry copy parameters: whole years when divisible, else months. */
export function expiryTerm(months: number): { readonly unit: "years" | "months"; readonly count: number } {
  return months > 0 && months % 12 === 0 ? { unit: "years", count: months / 12 } : { unit: "months", count: months };
}

/* ---- redeem ---- */

/** Crockford base32: uppercase, no I L O U; ambiguous letters are corrected, separators dropped. */
export function normaliseCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
}

export type CodeProblem = "empty" | "tooShort" | "badCharacters";

/** Local format check. A malformed code is never sent, so it cannot burn a server attempt. */
export function codeProblem(raw: string): CodeProblem | null {
  const c = normaliseCode(raw);
  if (c.length === 0) return "empty";
  if (!/^[0-9A-HJKMNP-TV-Z]+$/.test(c)) return "badCharacters";
  if (c.length < MIN_CODE_LENGTH) return "tooShort";
  return null;
}

export type RedeemState =
  | { readonly kind: "idle" }
  | { readonly kind: "success"; readonly amount: bigint }
  | { readonly kind: "invalid"; readonly remainingAttempts: number | null }
  | { readonly kind: "locked"; readonly retryAfterSeconds: number | null }
  | { readonly kind: "disabled" };

export function redeemStateFrom(o: RedeemOutcome): RedeemState {
  switch (o.kind) {
    case "redeemed": return { kind: "success", amount: o.amount };
    case "invalid": return { kind: "invalid", remainingAttempts: o.remainingAttempts };
    case "rateLimited": return { kind: "locked", retryAfterSeconds: o.retryAfterSeconds };
    case "disabled": return { kind: "disabled" };
  }
}

/** While rate limited the form cannot submit; the right code works again once the window passes. */
export function canSubmitRedeem(state: RedeemState, raw: string): boolean {
  return state.kind !== "locked" && state.kind !== "disabled" && codeProblem(raw) === null;
}

/* ---- owned cards and pots ---- */

export function canVoid(c: OwnedGiftCard): boolean {
  return c.status === "PENDING_PAYMENT" || c.status === "ISSUED";
}

export function potProgressPct(p: Pick<GiftPot, "raised" | "target">): number {
  if (p.target <= 0n) return 0;
  const v = Number((p.raised * 100n) / p.target);
  return Math.max(0, Math.min(100, v));
}

export type PotError = "targetInvalid" | "targetTooLow" | "targetTooHigh" | "closesInvalid" | "closesPast" | "titleRequired";

export function validatePot(targetText: string, closesOn: string, title: string, nowMs: number): readonly PotError[] {
  const errors: PotError[] = [];
  const target = parseAmountEgp(targetText);
  if (target === null) errors.push("targetInvalid");
  else if (target < MIN_CARD_AMOUNT) errors.push("targetTooLow");
  else if (target > MAX_CARD_AMOUNT) errors.push("targetTooHigh");
  if (title.trim().length === 0) errors.push("titleRequired");
  if (!validDateKey(closesOn.trim())) errors.push("closesInvalid");
  else if (closesOn.trim() <= cairoDateKey(nowMs)) errors.push("closesPast");
  return errors;
}

export function validateContribution(text: string): "invalid" | "tooLow" | null {
  const v = parseAmountEgp(text);
  if (v === null) return "invalid";
  return v < MIN_CONTRIBUTION ? "tooLow" : null;
}

export type GiftScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly snapshot: GiftSnapshot };

export function giftFailureState(e: unknown): GiftScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

/* ---- in-memory fake (development and tests only; synthetic data) ---- */

export const FIXTURE_GIFTS: GiftSnapshot = {
  capabilities: { sales: true, redemption: true },
  purchaserAdult: true,
  expiryMonths: 36,
  cards: [{ id: "gc1", last4: "7K2Q", amount: 50_000n, design: "eid", status: "ISSUED", expiresAt: null, scheduledDate: null }],
  pots: [{ id: "p1", title: "Layla wedding", target: 200_000n, raised: 50_000n, closesOn: "2099-01-01", status: "OPEN" }],
};

export class InMemoryGiftCardsPort implements GiftCardsPort {
  private snapshot: GiftSnapshot;
  private failedAttempts = 0;
  private readonly seen = new Map<string, unknown>();
  /** Fake limits mirror the spec: 5 failed redemptions per window, then 429. */
  static readonly ATTEMPT_LIMIT = 5;
  constructor(initial: GiftSnapshot = FIXTURE_GIFTS, private readonly validCodes: ReadonlyMap<string, bigint> = new Map([["0123456789ABCDEFG", 25_000n]]), private failure: PortFailure | null = null) {
    this.snapshot = initial;
  }
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  setCapabilities(c: GiftCapabilities): void {
    this.snapshot = { ...this.snapshot, capabilities: c };
  }
  private check(): void {
    if (this.failure !== null) throw new PortError(this.failure);
  }
  async load(): Promise<GiftSnapshot> {
    this.check();
    return this.snapshot;
  }
  async purchase(req: PurchaseRequest, key: string): Promise<PurchaseOutcome> {
    this.check();
    const prior = this.seen.get(key);
    if (prior !== undefined) return prior as PurchaseOutcome;
    let out: PurchaseOutcome;
    if (!this.snapshot.capabilities.sales) out = { kind: "disabled" };
    else if (req.amount > ADULT_PURCHASE_THRESHOLD && !this.snapshot.purchaserAdult) out = { kind: "ageGate" };
    else out = { kind: "created", cardId: `gc-${this.seen.size + 1}` };
    this.seen.set(key, out);
    return out;
  }
  async redeem(code: string): Promise<RedeemOutcome> {
    this.check();
    if (!this.snapshot.capabilities.redemption) return { kind: "disabled" };
    if (this.failedAttempts >= InMemoryGiftCardsPort.ATTEMPT_LIMIT) return { kind: "rateLimited", retryAfterSeconds: 3600 };
    const v = this.validCodes.get(code);
    if (v === undefined) {
      this.failedAttempts += 1;
      return { kind: "invalid", remainingAttempts: InMemoryGiftCardsPort.ATTEMPT_LIMIT - this.failedAttempts };
    }
    return { kind: "redeemed", amount: v };
  }
  async voidCard(cardId: string): Promise<void> {
    this.check();
    this.snapshot = { ...this.snapshot, cards: this.snapshot.cards.map((c) => (c.id === cardId ? { ...c, status: "VOIDED" } : c)) };
  }
  async createPot(target: bigint, closesOn: string, title: string): Promise<void> {
    this.check();
    const pot: GiftPot = { id: `p-${this.snapshot.pots.length + 1}`, title, target, raised: 0n, closesOn, status: "OPEN" };
    this.snapshot = { ...this.snapshot, pots: [...this.snapshot.pots, pot] };
  }
  async contribute(potId: string, amount: bigint): Promise<void> {
    this.check();
    this.snapshot = { ...this.snapshot, pots: this.snapshot.pots.map((p) => (p.id === potId ? { ...p, raised: p.raised + amount } : p)) };
  }
}
