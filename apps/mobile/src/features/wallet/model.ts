/**
 * Z-OUTLET credit wallet (spec §15.2, ADR-0003, ADR-0021, specs/store-credit.md). Closed loop and
 * read only: the port exposes a balance read and a transaction read, nothing else. There is no
 * top-up, withdrawal or transfer anywhere in this module. Money is integer piastres (bigint).
 */
import { PortError, type PortFailure } from "../worlds/model";

export { PortError };
export type { PortFailure };

export type SubBalanceKind = "refund_credit" | "gift_card" | "cashback_coins" | "referral_credit" | "goodwill";

/** Display order: soonest-expiring kinds first, refund credit last (it is spent last). */
export const SUB_BALANCE_ORDER: readonly SubBalanceKind[] = ["goodwill", "referral_credit", "cashback_coins", "gift_card", "refund_credit"];

export interface CreditLot {
  readonly id: string;
  readonly kind: SubBalanceKind;
  readonly remaining: bigint;
  /** Epoch ms; null for credit that never expires (refund credit). */
  readonly expiresAt: number | null;
  /** Last four characters of the gift card code, when the lot came from a card. */
  readonly last4: string | null;
}

export interface WalletSnapshot {
  readonly lots: readonly CreditLot[];
  /** Server-selected lots that expire soon; the window is the server's, not the client's. */
  readonly expiringSoon: readonly CreditLot[];
}

export type TransactionKind =
  | "credit_added" | "credit_spent" | "credit_released" | "credit_expired" | "credit_restored" | "other";

export interface WalletTransaction {
  readonly id: string;
  readonly kind: TransactionKind;
  readonly sub: SubBalanceKind;
  /** Signed: positive adds credit, negative uses it. */
  readonly amount: bigint;
  readonly at: number;
}

export interface TransactionPage {
  readonly items: readonly WalletTransaction[];
  readonly nextCursor: string | null;
}

/** Read-only by construction. Adding a method here needs a spec change (no top-up, withdrawal, transfer). */
export interface WalletPort {
  load(): Promise<WalletSnapshot>;
  transactions(cursor: string | null): Promise<TransactionPage>;
}

export interface SubBalanceView {
  readonly kind: SubBalanceKind;
  readonly amount: bigint;
  readonly lots: readonly CreditLot[];
  /** Earliest expiry across the lots, null when none expires. */
  readonly nextExpiry: number | null;
  readonly neverExpires: boolean;
}

export interface WalletView {
  readonly total: bigint;
  readonly subs: readonly SubBalanceView[];
  readonly expiringSoon: readonly CreditLot[];
  readonly isEmpty: boolean;
}

export function buildWallet(s: WalletSnapshot): WalletView {
  const live = s.lots.filter((l) => l.remaining > 0n);
  const subs: SubBalanceView[] = [];
  for (const kind of SUB_BALANCE_ORDER) {
    const lots = live.filter((l) => l.kind === kind).sort(byExpiry);
    if (lots.length === 0) continue;
    const dated = lots.map((l) => l.expiresAt).filter((e): e is number => e !== null);
    subs.push({
      kind,
      amount: lots.reduce((n, l) => n + l.remaining, 0n),
      lots,
      nextExpiry: dated.length === 0 ? null : Math.min(...dated),
      neverExpires: dated.length === 0,
    });
  }
  return {
    total: subs.reduce((n, b) => n + b.amount, 0n),
    subs,
    expiringSoon: [...s.expiringSoon].filter((l) => l.remaining > 0n).sort(byExpiry),
    isEmpty: subs.length === 0,
  };
}

function byExpiry(a: CreditLot, b: CreditLot): number {
  const ax = a.expiresAt ?? Number.POSITIVE_INFINITY;
  const bx = b.expiresAt ?? Number.POSITIVE_INFINITY;
  return ax === bx ? a.id.localeCompare(b.id) : ax < bx ? -1 : 1;
}

/* ---- transactions with cursor ---- */

export interface TransactionsState {
  readonly items: readonly WalletTransaction[];
  readonly nextCursor: string | null;
  readonly loaded: boolean;
}

export const EMPTY_TRANSACTIONS: TransactionsState = { items: [], nextCursor: null, loaded: false };

/** Appends a page, dropping rows already shown (a refetch after a retry must not duplicate). */
export function appendPage(state: TransactionsState, page: TransactionPage): TransactionsState {
  const seen = new Set(state.items.map((t) => t.id));
  const fresh = page.items.filter((t) => !seen.has(t.id));
  return { items: [...state.items, ...fresh], nextCursor: page.nextCursor, loaded: true };
}

export function canLoadMore(state: TransactionsState): boolean {
  return state.loaded && state.nextCursor !== null;
}

export type WalletScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly snapshot: WalletSnapshot };

export function walletFailureState(e: unknown): WalletScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

/* ---- in-memory fake (development and tests only; synthetic data) ---- */

const DAY = 86_400_000;

export function fixtureWallet(now: number): WalletSnapshot {
  const lots: CreditLot[] = [
    { id: "g1", kind: "goodwill", remaining: 5_000n, expiresAt: now + 10 * DAY, last4: null },
    { id: "c1", kind: "cashback_coins", remaining: 12_000n, expiresAt: now + 200 * DAY, last4: null },
    { id: "gc1", kind: "gift_card", remaining: 30_000n, expiresAt: now + 700 * DAY, last4: "7K2Q" },
    { id: "r1", kind: "refund_credit", remaining: 45_000n, expiresAt: null, last4: null },
  ];
  return { lots, expiringSoon: lots.filter((l) => l.id === "g1") };
}

export function fixtureTransactions(now: number, count: number): readonly WalletTransaction[] {
  return Array.from({ length: count }, (_, i): WalletTransaction => ({
    id: `t${i + 1}`,
    kind: i % 2 === 0 ? "credit_added" : "credit_spent",
    sub: i % 2 === 0 ? "refund_credit" : "goodwill",
    amount: i % 2 === 0 ? 10_000n : -2_500n,
    at: now - i * DAY,
  }));
}

export class InMemoryWalletPort implements WalletPort {
  constructor(
    private readonly snapshot: WalletSnapshot = fixtureWallet(Date.now()),
    private readonly txs: readonly WalletTransaction[] = fixtureTransactions(Date.now(), 25),
    private failure: PortFailure | null = null,
    private readonly pageSize = 10,
  ) {}
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  private check(): void {
    if (this.failure !== null) throw new PortError(this.failure);
  }
  async load(): Promise<WalletSnapshot> {
    this.check();
    return this.snapshot;
  }
  async transactions(cursor: string | null): Promise<TransactionPage> {
    this.check();
    const start = cursor === null ? 0 : Number(cursor);
    const end = start + this.pageSize;
    return { items: this.txs.slice(start, end), nextCursor: end < this.txs.length ? String(end) : null };
  }
}
