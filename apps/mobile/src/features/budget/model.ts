/** Budget suite and affordability (spec §12, phase2/03). Money is integer piastres (bigint). */
import { PortError, type PortFailure } from "../worlds/model";
import { type ServerClock } from "../drops/serverClock";

export { PortError };
export type { PortFailure };

export const SOFT_HOLD_MS = 10_000;
/** Hard-cap unlock delay shown to the shopper; the server enforces the real value. */
export const HARD_UNLOCK_HOURS = 24;
export const BUDGET_DELETE_HOURS = 24;

export type CapMode = "off" | "soft" | "hard";
export const CAP_MODES: readonly CapMode[] = ["off", "soft", "hard"];

export interface BudgetSettings {
  /** Piastres per cycle. */
  readonly amount: bigint;
  readonly payday: number;
  readonly capMode: CapMode;
}

export interface InstallmentCommitment {
  readonly id: string;
  readonly provider: string;
  readonly monthly: bigint;
  /** Provider data wins over the shopper's own entry (spec 03 edge cases). Both are estimates. */
  readonly source: "provider" | "user";
}

export interface WishlistItem {
  readonly id: string;
  readonly title: string;
  readonly price: bigint;
}

export interface BudgetSummary {
  readonly settings: BudgetSettings | null;
  readonly spentThisCycle: bigint;
  readonly bagTotal: bigint;
  readonly installmentsDueThisCycle: bigint;
  readonly installmentsNextCycle: bigint;
  readonly installments: readonly InstallmentCommitment[];
  readonly wishlist: readonly WishlistItem[];
  /** Server time when the summary was produced, and a pending hard-cap unlock if any. */
  readonly serverNowMs: number;
  readonly unlockAtMs: number | null;
}

export interface BudgetPort {
  consent(): Promise<boolean>;
  setConsent(granted: boolean): Promise<void>;
  /** Must not be called before consent; the server refuses with consent_required. */
  summary(): Promise<BudgetSummary>;
  saveSettings(s: BudgetSettings, idempotencyKey: string): Promise<void>;
  requestUnlock(idempotencyKey: string): Promise<{ unlockAtMs: number }>;
}

export interface Remaining {
  readonly remaining: bigint;
  readonly over: boolean;
  /** Display value, clamped to zero when over; the overshoot is shown separately. */
  readonly display: bigint;
  readonly overBy: bigint;
}

/** remaining = budget - spent - (bag if toggled) - installments due this cycle (spec §12). */
export function remainingNow(s: BudgetSummary, includeBag: boolean): Remaining | null {
  if (s.settings === null) return null;
  const raw = s.settings.amount - s.spentThisCycle - (includeBag ? s.bagTotal : 0n) - s.installmentsDueThisCycle;
  return { remaining: raw, over: raw < 0n, display: raw < 0n ? 0n : raw, overBy: raw < 0n ? -raw : 0n };
}

/** A fresh cycle: the full budget minus installments due next cycle (provider/user estimates). */
export function availableAfterPayday(s: BudgetSummary): bigint | null {
  if (s.settings === null) return null;
  const v = s.settings.amount - s.installmentsNextCycle;
  return v < 0n ? 0n : v;
}

export type Affordability = "now" | "afterPayday" | "no";
export function affordability(price: bigint, nowAvailable: bigint, afterPayday: bigint): Affordability {
  if (price <= nowAvailable) return "now";
  return price <= afterPayday ? "afterPayday" : "no";
}

export function wishlistAffordability(s: BudgetSummary, includeBag: boolean): readonly { readonly item: WishlistItem; readonly status: Affordability }[] {
  const r = remainingNow(s, includeBag);
  const after = availableAfterPayday(s);
  if (r === null || after === null) return [];
  return s.wishlist.map((item) => ({ item, status: affordability(item.price, r.display, after) }));
}

/** Payday 31 in a 30-day month means the last day of that month (spec 03 acceptance). */
export function effectivePayday(payday: number, year: number, monthIndex: number): number {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Math.min(Math.max(1, payday), last);
}

export type AmountParse = { readonly ok: true; readonly value: bigint } | { readonly ok: false };
export function parseAmountEgp(raw: string): AmountParse {
  const s = raw.trim().replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  if (!/^[0-9]{1,8}$/.test(s)) return { ok: false };
  const v = BigInt(s);
  return v === 0n ? { ok: false } : { ok: true, value: v * 100n };
}
export function parsePayday(raw: string): number | null {
  const s = raw.trim().replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  if (!/^[0-9]{1,2}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 31 ? n : null;
}

export type CapState =
  | { readonly kind: "off" }
  | { readonly kind: "notReached" }
  | { readonly kind: "softReached" }
  | { readonly kind: "hardReached" };

/** Cap is "reached" only when nothing remains; mode off never blocks. */
export function capState(mode: CapMode, r: Remaining | null): CapState {
  if (mode === "off" || r === null) return { kind: "off" };
  const reached = r.remaining <= 0n;
  if (!reached) return { kind: "notReached" };
  return mode === "soft" ? { kind: "softReached" } : { kind: "hardReached" };
}

export interface HoldState {
  readonly remainingMs: number;
  readonly done: boolean;
}
/** Soft cap friction: a real 10 s wait the shopper must sit through, measured from when they started. */
export function holdState(startedAtMs: number | null, nowMs: number, durationMs = SOFT_HOLD_MS): HoldState | null {
  if (startedAtMs === null) return null;
  const remaining = Math.max(0, durationMs - (nowMs - startedAtMs));
  return { remainingMs: remaining, done: remaining === 0 };
}
export function holdSeconds(h: HoldState): number {
  return Math.ceil(h.remainingMs / 1000);
}

export type UnlockState =
  | { readonly kind: "none" }
  | { readonly kind: "pending"; readonly unlockAtMs: number }
  | { readonly kind: "ready" };

/** Hard cap unlock is judged on SERVER time so changing the device clock cannot shorten the delay. */
export function unlockState(unlockAtMs: number | null, clock: ServerClock, deviceNowMs: number): UnlockState {
  if (unlockAtMs === null) return { kind: "none" };
  return deviceNowMs + clock.offsetMs >= unlockAtMs ? { kind: "ready" } : { kind: "pending", unlockAtMs };
}

export type BudgetScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "consent"; readonly failed: boolean }
  | { readonly status: "ready"; readonly summary: BudgetSummary };

export function budgetFailureState(e: unknown): BudgetScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

/* ---- in-memory fakes (development and tests only; synthetic data) ---- */

export const FIXTURE_SUMMARY: BudgetSummary = {
  settings: { amount: 500_000n, payday: 25, capMode: "soft" },
  spentThisCycle: 320_000n,
  bagTotal: 90_000n,
  installmentsDueThisCycle: 62_000n,
  installmentsNextCycle: 62_000n,
  installments: [{ id: "i1", provider: "Provider A", monthly: 62_000n, source: "provider" }],
  wishlist: [
    { id: "w1", title: "Linen shirt", price: 40_000n },
    { id: "w2", title: "Leather jacket", price: 300_000n },
    { id: "w3", title: "Designer coat", price: 900_000n },
  ],
  serverNowMs: 1_800_000_000_000,
  unlockAtMs: null,
};

export class InMemoryBudgetPort implements BudgetPort {
  private granted: boolean;
  private data: BudgetSummary;
  constructor(initial: BudgetSummary = FIXTURE_SUMMARY, granted = false, private failure: PortFailure | null = null) {
    this.data = initial;
    this.granted = granted;
  }
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  private check(): void {
    if (this.failure !== null) throw new PortError(this.failure);
  }
  async consent(): Promise<boolean> {
    this.check();
    return this.granted;
  }
  async setConsent(granted: boolean): Promise<void> {
    this.check();
    this.granted = granted;
    if (!granted) this.data = { ...this.data, settings: null, wishlist: [], installments: [], unlockAtMs: null };
  }
  async summary(): Promise<BudgetSummary> {
    this.check();
    if (!this.granted) throw new PortError("failed");
    return this.data;
  }
  async saveSettings(s: BudgetSettings): Promise<void> {
    this.check();
    this.data = { ...this.data, settings: s };
  }
  async requestUnlock(): Promise<{ unlockAtMs: number }> {
    this.check();
    const unlockAtMs = this.data.serverNowMs + HARD_UNLOCK_HOURS * 3_600_000;
    this.data = { ...this.data, unlockAtMs };
    return { unlockAtMs };
  }
}
