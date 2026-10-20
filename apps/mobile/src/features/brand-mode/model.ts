/**
 * Brand mode (spec §19, §19.1, brand-onboarding §7, seller-settings). Pure model: types, ports and the
 * view-model logic the screens use. No React, no router. Money is bigint piastres everywhere.
 */
import { PortError } from "../worlds/model";
import type { DashboardSummary, SummaryPeriod } from "./summaryModel";

export { PortError };

export type BrandRole = "owner" | "manager" | "catalog" | "warehouse" | "finance" | "support";
export type Bilingual = { readonly ar: string; readonly en: string };

export interface BrandAccount {
  readonly storeId: string;
  readonly name: Bilingual;
  readonly role: BrandRole;
  readonly kind: "local" | "global";
}

/** Which tabs/actions a role may use (mirrors the central policy: foreign or forbidden = hidden, server is the authority). */
export type BrandCapability = "orders_write" | "catalog_write" | "finance_read" | "payout_write" | "settings_write" | "team_write";
const CAPS: Readonly<Record<BrandRole, readonly BrandCapability[]>> = {
  owner: ["orders_write", "catalog_write", "finance_read", "payout_write", "settings_write", "team_write"],
  manager: ["orders_write", "catalog_write", "finance_read", "settings_write"],
  catalog: ["catalog_write"],
  warehouse: ["orders_write"],
  finance: ["finance_read", "payout_write"],
  support: [],
};
export function can(role: BrandRole, cap: BrandCapability): boolean {
  return CAPS[role].includes(cap);
}

/* ------------------------------------------------------------------ money */

const EASTERN = "٠١٢٣٤٥٦٧٨٩";
const MAX_PRICE_PIASTRES = 1_000_000_000n; // 10,000,000 EGP

export type PriceParse =
  | { readonly ok: true; readonly piastres: bigint }
  | { readonly ok: false; readonly code: "empty" | "format" | "too_many_decimals" | "not_positive" | "too_large" };

/** "1,250.5", "١٢٥٠٫٥٠" -> piastres. Never goes through a float. */
export function parseEgp(input: string): PriceParse {
  const norm = input
    .trim()
    .replace(/[٠-٩]/g, (d) => String(EASTERN.indexOf(d)))
    .replace(/[٬,\s]/g, "")
    .replace(/٫/g, ".");
  if (norm === "") return { ok: false, code: "empty" };
  if (!/^\d+(\.\d*)?$/.test(norm)) return { ok: false, code: "format" };
  const [whole = "0", frac = ""] = norm.split(".");
  if (frac.length > 2) return { ok: false, code: "too_many_decimals" };
  const piastres = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
  if (piastres <= 0n) return { ok: false, code: "not_positive" };
  if (piastres > MAX_PRICE_PIASTRES) return { ok: false, code: "too_large" };
  return { ok: true, piastres };
}

/* -------------------------------------------------------------------- IBAN */

/** Egyptian IBAN: EG + 2 check digits + 25 digits, ISO 7064 mod 97-10. */
export type IbanCheck = { readonly ok: true; readonly normalized: string; readonly last4: string } | { readonly ok: false; readonly code: "length" | "country" | "format" | "checksum" };

export function normalizeIban(input: string): string {
  return input.replace(/[٠-٩]/g, (d) => String(EASTERN.indexOf(d))).replace(/[\s-]/g, "").toUpperCase();
}

export function validateIban(input: string): IbanCheck {
  const s = normalizeIban(input);
  if (!s.startsWith("EG")) return { ok: false, code: "country" };
  if (s.length !== 29) return { ok: false, code: "length" };
  if (!/^EG\d{27}$/.test(s)) return { ok: false, code: "format" };
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  if (rem !== 1) return { ok: false, code: "checksum" };
  return { ok: true, normalized: s, last4: s.slice(-4) };
}

/** Masked display: only the country and the last 4 are ever shown. */
export function maskIban(last4: string): string {
  return `EG•• •••• •••• •••• •••• •••• ${last4}`;
}

export type NameMatch = "match" | "partial" | "mismatch";
/** Score from the server (min 85 = match). 70..84 asks for a corrected name, below is a mismatch. */
export function nameMatchFromScore(score: number): NameMatch {
  return score >= 85 ? "match" : score >= 70 ? "partial" : "mismatch";
}

export const PAYOUT_HOLD_HOURS = 48;
/** A replacement account is ACTIVE with `activates_at = now + 48 h`; payouts to it stay held until then. */
export function payoutHoldUntil(changedAtMs: number, hadActiveAccount: boolean): number | null {
  return hadActiveAccount ? changedAtMs + PAYOUT_HOLD_HOURS * 3_600_000 : null;
}

/** A strong factor is "recent" for 300 s (seller-settings spec). */
export const STRONG_FACTOR_WINDOW_MS = 300_000;
export function strongFactorFresh(verifiedAtMs: number | null, serverNowMs: number): boolean {
  return verifiedAtMs !== null && serverNowMs - verifiedAtMs <= STRONG_FACTOR_WINDOW_MS && serverNowMs >= verifiedAtMs;
}

/* ------------------------------------------------------------- server time */

/** Countdowns use SERVER time: offset = serverNow - deviceNow, measured when the payload arrived. */
export interface ServerClock {
  readonly offsetMs: number;
}
export function serverClock(serverNowMs: number, deviceNowMs: number): ServerClock {
  return { offsetMs: serverNowMs - deviceNowMs };
}
export function serverNow(clock: ServerClock, deviceNowMs: number): number {
  return deviceNowMs + clock.offsetMs;
}

export type SlaLevel = "ok" | "warning" | "breached";
export interface SlaView {
  readonly remainingMs: number;
  readonly level: SlaLevel;
  readonly hours: number;
  readonly minutes: number;
}
/** Accept SLA is 24 h; warning under 4 h; at 0 the order auto-cancels (spec §19). */
export function slaCountdown(acceptByMs: number, nowServerMs: number): SlaView {
  const remaining = acceptByMs - nowServerMs;
  if (remaining <= 0) return { remainingMs: 0, level: "breached", hours: 0, minutes: 0 };
  const totalMin = Math.ceil(remaining / 60_000);
  return {
    remainingMs: remaining,
    level: remaining < 4 * 3_600_000 ? "warning" : "ok",
    hours: Math.floor(totalMin / 60),
    minutes: totalMin % 60,
  };
}

/** "3 minutes ago"-style freshness input; null when unknown (the screen says so, never invents "now"). */
export function freshnessMinutes(freshnessAtMs: number | null, nowServerMs: number): number | null {
  if (freshnessAtMs === null) return null;
  return Math.max(0, Math.floor((nowServerMs - freshnessAtMs) / 60_000));
}

/* ------------------------------------------------------------------ orders */

export type OrderStatus =
  | "PENDING_PAYMENT" | "PAID" | "CONFIRMED_COD" | "ACCEPTED" | "PACKED" | "SHIPPED" | "OUT_FOR_DELIVERY" | "DELIVERED" | "CLOSED"
  | "RETURN_REQUESTED" | "RETURN_RECEIVED" | "RETURN_INSPECTED" | "REFUNDED" | "RETURN_REJECTED"
  | "CANCELLED" | "REJECTED_BY_SELLER" | "DELIVERY_FAILED" | "RTO" | "DISPUTED";

export type OrderQueue = "awaiting" | "toPack" | "shipped" | "returns" | "done";
export const ORDER_QUEUES: readonly OrderQueue[] = ["awaiting", "toPack", "shipped", "returns", "done"];

export function queueOf(s: OrderStatus): OrderQueue {
  switch (s) {
    case "PAID": case "CONFIRMED_COD": return "awaiting";
    case "ACCEPTED": case "PACKED": return "toPack";
    case "SHIPPED": case "OUT_FOR_DELIVERY": case "DELIVERY_FAILED": return "shipped";
    case "RETURN_REQUESTED": case "RETURN_RECEIVED": case "RTO": case "DISPUTED": return "returns";
    default: return "done";
  }
}

export type OrderAction = "accept" | "reject" | "pack" | "markReady" | "printLabel" | "inspectReturn";

/** Which actions the order status allows for the role. The server stays the authority (409 on a stale tap). */
export function orderActions(status: OrderStatus, role: BrandRole, slaBreached: boolean): readonly OrderAction[] {
  if (!can(role, "orders_write")) return [];
  switch (status) {
    case "PAID": case "CONFIRMED_COD": return slaBreached ? [] : ["accept", "reject"];
    case "ACCEPTED": return ["pack", "reject"];
    case "PACKED": return ["markReady", "printLabel"];
    case "RETURN_RECEIVED": return ["inspectReturn"];
    default: return [];
  }
}

export interface OrderBuyer {
  readonly firstName: string | null;
  readonly governorate: string;
  readonly phoneRelay: string | null;
}
export interface BrandOrderLine { readonly id: string; readonly title: string; readonly sizeLabel: string | null; readonly qty: number; readonly unitPrice: bigint }
export interface BrandOrder {
  readonly id: string;
  readonly status: OrderStatus;
  readonly lines: readonly BrandOrderLine[];
  readonly subtotal: bigint;
  readonly netToSeller: bigint | null;
  readonly buyer: OrderBuyer;
  readonly payment: "prepaid" | "cod";
  readonly acceptByMs: number;
  readonly createdAtMs: number;
  readonly awbUrl: string | null;
}

/**
 * Buyer data minimisation (B1): until the order is accepted only first name + governorate are shown;
 * the relay number appears from ACCEPTED and disappears again once the order is closed.
 */
export function maskedBuyer(b: OrderBuyer, status: OrderStatus): { firstName: string | null; governorate: string; phoneRelay: string | null } {
  const active = status === "ACCEPTED" || status === "PACKED" || status === "SHIPPED" || status === "OUT_FOR_DELIVERY" || status === "DELIVERY_FAILED" || status === "RETURN_REQUESTED" || status === "RETURN_RECEIVED";
  return { firstName: b.firstName, governorate: b.governorate, phoneRelay: active ? b.phoneRelay : null };
}

export type RejectReason = "out_of_stock" | "pricing_error" | "cannot_fulfil" | "other";
export const REJECT_REASONS: readonly RejectReason[] = ["out_of_stock", "pricing_error", "cannot_fulfil", "other"];
export function rejectValid(reason: RejectReason | null, note: string): boolean {
  if (reason === null) return false;
  return note.length <= 500 && (reason !== "other" || note.trim().length >= 3);
}

/* --------------------------------------------------------------- dashboard */

export type Metric<T> = { readonly kind: "value"; readonly value: T } | { readonly kind: "unavailable" };
export const metric = <T,>(v: T | null | undefined): Metric<T> => (v === null || v === undefined ? { kind: "unavailable" } : { kind: "value", value: v });

export interface LowStockItem { readonly skuId: string; readonly productTitle: string; readonly sizeLabel: string; readonly available: number }
export interface PayoutSummary {
  readonly available: bigint | null;
  readonly pendingRelease: bigint | null;
  readonly held: bigint | null;
  /** Reasons the server gave for holds (codes); empty when none or not provided. */
  readonly heldReasons: readonly string[];
  readonly nextPayoutAtMs: number | null;
}
export interface PriceTrustView {
  readonly score: number | null;
  readonly ladder: "good_standing" | "badge_removed" | "surcharge_active" | "suspended";
  readonly violations: number;
  readonly windowDays: number;
  readonly fixes: readonly { readonly action: string; readonly cure: Bilingual | null }[];
}
export interface StoreHealth { readonly score: number | null; readonly dispatchOnTimeBp: number | null; readonly cancellationBp: number | null; readonly returnBp: number | null }

export interface DashboardData {
  /** Server time when the payload was produced (for the clock offset and freshness). */
  readonly serverNowMs: number;
  readonly freshnessAtMs: number | null;
  readonly salesToday: bigint | null;
  readonly ordersToday: number | null;
  readonly awaiting: readonly BrandOrder[];
  readonly lowStock: readonly LowStockItem[];
  readonly payout: PayoutSummary;
  readonly trust: PriceTrustView;
  readonly health: StoreHealth;
  /** Optional (absent = the section is hidden, never zero-filled): daily gross sales, oldest first, last 7 Cairo days. */
  readonly salesTrend?: readonly bigint[] | undefined;
  /** Optional: newest orders that are past the awaiting queue (shipped, delivered ...). */
  readonly recentOrders?: readonly BrandOrder[] | undefined;
  /** Optional: value of parcels handed to the courier and not yet released to the seller. */
  readonly inTransit?: bigint | null | undefined;
  /** Optional: current seller subscription plan (ADR-0056). Read-only here; changes are in the Seller Center. */
  readonly plan?: { readonly code: string; readonly name: Bilingual } | undefined;
}

export const LOW_STOCK_THRESHOLD = 3;
export function lowStock(skus: readonly { skuId: string; productTitle: string; sizeLabel: string; available: number }[], status: (id: string) => boolean = () => true): LowStockItem[] {
  return skus.filter((s) => s.available <= LOW_STOCK_THRESHOLD && status(s.skuId)).sort((a, b) => a.available - b.available);
}

export interface DashboardView {
  readonly sales: Metric<bigint>;
  readonly orders: Metric<number>;
  readonly freshnessMin: number | null;
  readonly awaiting: readonly { readonly order: BrandOrder; readonly sla: SlaView }[];
  readonly awaitingBreached: number;
  readonly lowStock: readonly LowStockItem[];
  readonly payoutEligible: Metric<bigint>;
  readonly payoutHeld: bigint | null;
  readonly trustFixes: PriceTrustView["fixes"];
  readonly trustBad: boolean;
}

/** Null analytics fields stay "unavailable" (the screen shows "Not enough data"), never 0. */
export function buildDashboard(d: DashboardData, clock: ServerClock, deviceNowMs: number): DashboardView {
  const now = serverNow(clock, deviceNowMs);
  const awaiting = [...d.awaiting]
    .map((order) => ({ order, sla: slaCountdown(order.acceptByMs, now) }))
    .sort((a, b) => a.order.acceptByMs - b.order.acceptByMs);
  return {
    sales: metric(d.salesToday),
    orders: metric(d.ordersToday),
    freshnessMin: freshnessMinutes(d.freshnessAtMs, now),
    awaiting,
    awaitingBreached: awaiting.filter((a) => a.sla.level === "breached").length,
    lowStock: d.lowStock,
    payoutEligible: metric(d.payout.available),
    payoutHeld: d.payout.held !== null && d.payout.held > 0n ? d.payout.held : null,
    trustFixes: d.trust.fixes,
    trustBad: d.trust.ladder !== "good_standing",
  };
}

/* ---------------------------------------------------------------- products */

export type Condition = "new_with_tags" | "new_without_tags" | "sample" | "minor_defect";
export const CONDITIONS: readonly Condition[] = ["new_with_tags", "new_without_tags", "sample", "minor_defect"];
/** Shopper department (wire `department`). Accessories is a category, not a department. */
export type Department = "women" | "men" | "kids" | "unisex";
export const DEPARTMENTS: readonly Department[] = ["women", "men", "kids", "unisex"];
export type ProductStatus = "draft" | "active" | "paused" | "auto_paused_price_parity" | "delisted";
export type PhotoState = "queued" | "uploading" | "done" | "failed";
export interface PhotoItem {
  readonly localId: string;
  readonly uri: string;
  readonly uploadId: string | null;
  readonly progress: number;
  readonly state: PhotoState;
  /** Background-removal job backing this image (accepted cutout or use-original). Sent as images[].media_job_id. */
  readonly mediaJobId?: string | null;
}
export interface SizeRow { readonly label: string; readonly stock: string }
export const MAX_PHOTOS = 12;
export const MAX_SIZES = 100;

export interface ProductDraft {
  readonly id: string | null;
  readonly photos: readonly PhotoItem[];
  readonly defectPhotos: readonly PhotoItem[];
  readonly titleAr: string;
  readonly titleEn: string;
  readonly descAr: string;
  readonly descEn: string;
  readonly categoryId: string | null;
  readonly condition: Condition | null;
  /** Always set: unisex unless the seller picks one (server default). */
  readonly department: Department;
  readonly priceInput: string;
  readonly sizes: readonly SizeRow[];
  readonly sizeChartId: string | null;
  readonly sku: string;
  readonly barcode: string;
}

export const EMPTY_DRAFT: ProductDraft = {
  id: null, photos: [], defectPhotos: [], titleAr: "", titleEn: "", descAr: "", descEn: "", categoryId: null, condition: null, department: "unisex",
  priceInput: "", sizes: [{ label: "", stock: "" }], sizeChartId: null, sku: "", barcode: "",
};

export type FieldCode =
  | "required" | "arabic_required" | "too_short" | "too_long" | "price_format" | "price_decimals" | "price_not_positive" | "price_too_large"
  | "stock_invalid" | "size_duplicate" | "size_too_long" | "barcode_invalid";
export type DraftField = "titleAr" | "titleEn" | "descAr" | "price" | "sizes" | "barcode" | "sku";
export type FieldErrors = Partial<Record<DraftField, FieldCode>>;

const ARABIC_LETTER = /[ء-يٱ-ۓ]/;

export function validateTitleAr(v: string): FieldCode | null {
  const s = v.trim();
  if (s === "") return "required";
  if (!ARABIC_LETTER.test(s)) return "arabic_required";
  if (s.length < 3) return "too_short";
  if (s.length > 120) return "too_long";
  return null;
}

export function validateSizes(rows: readonly SizeRow[]): { rowErrors: readonly (FieldCode | null)[]; ok: boolean } {
  const seen = new Set<string>();
  const rowErrors = rows.map((r): FieldCode | null => {
    const label = r.label.trim().toUpperCase();
    if (label === "") return "required";
    if (label.length > 20) return "size_too_long";
    if (seen.has(label)) return "size_duplicate";
    seen.add(label);
    if (r.stock.trim() !== "" && !/^\d{1,6}$/.test(r.stock.trim())) return "stock_invalid";
    if (r.stock.trim() !== "" && Number(r.stock) > 100000) return "stock_invalid";
    return null;
  });
  return { rowErrors, ok: rows.length > 0 && rows.length <= MAX_SIZES && rowErrors.every((e) => e === null) };
}

/** GTIN-8/12/13/14 with the GS1 check digit; empty is allowed (barcode is optional). */
export function validateGtin(v: string): boolean {
  const s = v.trim();
  if (s === "") return true;
  if (!/^\d+$/.test(s) || ![8, 12, 13, 14].includes(s.length)) return false;
  const digits = [...s].map(Number);
  const check = digits.pop() ?? 0;
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

export function validateDraft(d: ProductDraft): FieldErrors {
  const e: { -readonly [K in DraftField]?: FieldCode } = {};
  const t = validateTitleAr(d.titleAr);
  if (t !== null && !(t === "required" && d.titleAr === "")) e.titleAr = t;
  if (d.titleEn.length > 120) e.titleEn = "too_long";
  if (d.priceInput.trim() !== "") {
    const p = parseEgp(d.priceInput);
    if (!p.ok) e.price = p.code === "format" || p.code === "empty" ? "price_format" : p.code === "too_many_decimals" ? "price_decimals" : p.code === "not_positive" ? "price_not_positive" : "price_too_large";
  }
  const s = validateSizes(d.sizes.filter((r, i) => i === 0 || r.label.trim() !== "" || r.stock.trim() !== ""));
  const firstErr = s.rowErrors.find((x) => x !== null && x !== "required");
  if (firstErr !== undefined && firstErr !== null) e.sizes = firstErr;
  if (!validateGtin(d.barcode)) e.barcode = "barcode_invalid";
  return e;
}

export type MissingItem =
  | "photos" | "uploads_pending" | "titleAr" | "category" | "condition" | "defect_photos" | "price" | "sizes" | "size_chart" | "barcode";

export interface PublishGate {
  readonly canPublish: boolean;
  readonly missing: readonly MissingItem[];
}

/**
 * What exactly blocks publishing. Size chart is required when the category has sizes (no chart = no size
 * recommendation, spec §10). Defect photos are required for minor_defect (spec §4). Uploads must be finished.
 */
export function publishGate(d: ProductDraft, category: { readonly sized: boolean } | null): PublishGate {
  const missing: MissingItem[] = [];
  if (d.photos.length === 0) missing.push("photos");
  else if ([...d.photos, ...d.defectPhotos].some((p) => p.state !== "done")) missing.push("uploads_pending");
  if (validateTitleAr(d.titleAr) !== null) missing.push("titleAr");
  if (d.categoryId === null) missing.push("category");
  if (d.condition === null) missing.push("condition");
  if (d.condition === "minor_defect" && d.defectPhotos.length === 0) missing.push("defect_photos");
  if (!parseEgp(d.priceInput).ok) missing.push("price");
  const filled = d.sizes.filter((r) => r.label.trim() !== "");
  if (filled.length === 0 || !validateSizes(filled).ok) missing.push("sizes");
  if (category?.sized === true && d.sizeChartId === null) missing.push("size_chart");
  if (!validateGtin(d.barcode)) missing.push("barcode");
  return { canPublish: missing.length === 0, missing };
}

/** Reorder helper for the photo strip (first = cover). Returns the same array when the move is a no-op. */
export function movePhoto<T>(items: readonly T[], from: number, to: number): readonly T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items];
  const [it] = next.splice(from, 1);
  if (it === undefined) return items;
  next.splice(to, 0, it);
  return next;
}

export interface BrandProduct {
  readonly id: string;
  readonly status: ProductStatus;
  readonly titleAr: string;
  readonly titleEn: string | null;
  readonly coverUri: string | null;
  readonly priceFrom: bigint | null;
  readonly totalStock: number;
  readonly sizes: number;
  readonly claim: "none" | "verified_discount" | "lowest_30d" | "launch_price";
  /** Verified reference price (VRP). Shown struck-through ONLY when claim is verified_discount; otherwise ignored. */
  readonly referencePrice?: bigint | null | undefined;
  readonly updatedAtMs: number;
}

export type ProductFilter = "all" | "active" | "draft" | "paused" | "lowStock";
export function filterProducts(list: readonly BrandProduct[], filter: ProductFilter, query: string): readonly BrandProduct[] {
  const q = query.trim().toLowerCase();
  return list.filter((p) => {
    if (filter === "active" && p.status !== "active") return false;
    if (filter === "draft" && p.status !== "draft") return false;
    if (filter === "paused" && p.status !== "paused" && p.status !== "auto_paused_price_parity") return false;
    if (filter === "lowStock" && !(p.totalStock <= LOW_STOCK_THRESHOLD)) return false;
    if (q !== "" && !(p.titleAr.toLowerCase().includes(q) || (p.titleEn ?? "").toLowerCase().includes(q))) return false;
    return true;
  });
}

/* ------------------------------------------------------------------- store */

export const STATUTORY_MIN_RETURN_DAYS = 14;
export const STATUTORY_MIN_DEFECT_DAYS = 30;
export const MAX_RETURN_DAYS = 90;
export function validateReturnPolicy(changeOfMind: number, defect: number): { changeOfMind: boolean; defect: boolean } {
  return {
    changeOfMind: Number.isInteger(changeOfMind) && changeOfMind >= STATUTORY_MIN_RETURN_DAYS && changeOfMind <= MAX_RETURN_DAYS,
    defect: Number.isInteger(defect) && defect >= STATUTORY_MIN_DEFECT_DAYS && defect <= MAX_RETURN_DAYS,
  };
}
export function validateHandlingHours(h: number): boolean {
  return Number.isInteger(h) && h >= 12 && h <= 168;
}
/** Vacation needs an end date, max 90 days, in the future. */
export function validateVacation(endMs: number | null, nowMs: number): "ok" | "end_required" | "past" | "too_long" {
  if (endMs === null) return "end_required";
  if (endMs <= nowMs) return "past";
  return endMs - nowMs > 90 * 86_400_000 ? "too_long" : "ok";
}
/** Egyptian mobile in national or international form -> +20 E.164, else null. */
export function normalizeEgPhone(input: string): string | null {
  const s = input.replace(/[٠-٩]/g, (d) => String(EASTERN.indexOf(d))).replace(/[\s-]/g, "");
  const m = /^(?:\+20|0020|0)?(1[0125]\d{8})$/.exec(s);
  return m === null || m[1] === undefined ? null : `+20${m[1]}`;
}

export interface StoreSettings {
  readonly name: Bilingual;
  readonly description: Bilingual;
  readonly logoUri: string | null;
  readonly coverUri: string | null;
  readonly social: { readonly instagram: string; readonly website: string };
  readonly returnDays: { readonly changeOfMind: number; readonly defect: number };
  readonly shipping: { readonly governorate: string; readonly city: string; readonly street: string; readonly handlingHours: number };
  readonly vacationEndMs: number | null;
  readonly payout: { readonly last4: string | null; readonly holder: string | null; readonly nameMatch: NameMatch | null; readonly activatesAtMs: number | null };
  readonly notifications: Readonly<Record<NotificationEvent, boolean>>;
  readonly version: number;
}
export type NotificationEvent = "new_order" | "sla_warning" | "low_stock" | "payout" | "price_trust";
export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = ["new_order", "sla_warning", "low_stock", "payout", "price_trust"];
/** Transactional events cannot be turned off (seller-settings rules). */
export const LOCKED_NOTIFICATIONS: readonly NotificationEvent[] = ["new_order", "sla_warning"];

export interface TeamMember { readonly id: string; readonly name: string; readonly role: BrandRole; readonly status: "active" | "invited" }
export type InviteRole = "manager" | "catalog" | "warehouse" | "finance";
export const INVITE_ROLES: readonly InviteRole[] = ["manager", "catalog", "warehouse", "finance"];

export interface Category { readonly id: string; readonly name: Bilingual; readonly sized: boolean }
export interface SizeChartOption { readonly id: string; readonly name: string; readonly validated: boolean }
export interface ReturnInspection { readonly id: string; readonly orderId: string; readonly reason: string; readonly receivedAtMs: number | null }
export type InspectResult = "accept" | "reject";

export interface PayoutAccountResult { readonly last4: string; readonly nameMatch: NameMatch; readonly activatesAtMs: number | null }

/** Session expired / strong factor needed: screens send the user through re-auth, not a generic error. */
export type BrandFailure = "offline" | "failed" | "session_expired" | "forbidden" | "conflict" | "unsupported";
export class BrandPortError extends Error {
  constructor(readonly kind: BrandFailure) {
    super(`brand port: ${kind}`);
    this.name = "BrandPortError";
  }
}

export interface BrandPort {
  account(): Promise<BrandAccount>;
  dashboard(): Promise<DashboardData>;
  /** Period overview with previous-period comparison. null = the summary endpoint is flagged off (404): the screen shows the simple fallback. */
  dashboardSummary(period: SummaryPeriod): Promise<DashboardSummary | null>;
  categories(): Promise<readonly Category[]>;
  sizeCharts(): Promise<readonly SizeChartOption[]>;
  listProducts(): Promise<readonly BrandProduct[]>;
  getProduct(id: string): Promise<ProductDraft>;
  /** Bulk signed upload URLs happen inside the adapter; progress is reported per photo. */
  uploadPhotos(uris: readonly string[], onProgress: (index: number, progress: number) => void): Promise<readonly { uploadId: string }[]>;
  saveProduct(draft: ProductDraft, publish: boolean): Promise<{ id: string; status: ProductStatus }>;
  listOrders(): Promise<readonly BrandOrder[]>;
  acceptOrder(id: string): Promise<BrandOrder>;
  rejectOrder(id: string, reason: RejectReason, note: string): Promise<BrandOrder>;
  packOrder(id: string): Promise<BrandOrder>;
  markReady(id: string): Promise<BrandOrder>;
  /** AWB label as a `data:application/pdf;base64,` URI (creates the shipment for the order when needed). */
  labelUri(orderId: string): Promise<string>;
  listReturns(): Promise<readonly ReturnInspection[]>;
  inspectReturn(id: string, result: InspectResult, note: string): Promise<void>;
  store(): Promise<StoreSettings>;
  saveStore(s: StoreSettings): Promise<StoreSettings>;
  uploadStoreMedia(slot: "logo" | "cover", uri: string): Promise<string>;
  /** Needs a strong factor verified in the last 300 s; throws session_expired otherwise. */
  savePayoutAccount(iban: string, holder: string): Promise<PayoutAccountResult>;
  verifyStrongFactor(code: string): Promise<void>;
  team(): Promise<readonly TeamMember[]>;
  invite(phoneE164: string, role: InviteRole): Promise<TeamMember>;
  revoke(id: string): Promise<void>;
}

export type LoadState<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: T; readonly stale: boolean }
  | { readonly status: "error"; readonly failure: BrandFailure };

export function failureOf(e: unknown): BrandFailure {
  if (e instanceof BrandPortError) return e.kind;
  if (e instanceof PortError) return e.kind === "offline" ? "offline" : "failed";
  return "failed";
}

/** Last good value stays on screen (marked stale) when a refresh fails offline. */
export function afterFailure<T>(prev: LoadState<T>, failure: BrandFailure): LoadState<T> {
  if (prev.status === "ready" && failure === "offline") return { status: "ready", data: prev.data, stale: true };
  return { status: "error", failure };
}
