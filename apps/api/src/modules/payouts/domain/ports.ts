import type {
  ApprovalConfig,
  ApprovalRecord,
  Clawback,
  HoldReason,
  PayableItem,
  PayoutEvent,
  PayoutState,
  StatementFact,
} from "./bridge";

export type { HoldReason, PayoutEvent, PayoutState };

export type PayoutLineSource = "seller_order" | "clawback";

export interface PayoutLineRecord {
  readonly sourceType: PayoutLineSource;
  readonly sourceId: string;
  readonly amount: bigint;
}

export interface PayoutRecord {
  readonly id: string;
  readonly storeId: string;
  readonly cycleKey: string;
  readonly cutoffAtMs: number;
  readonly status: PayoutState;
  readonly amount: bigint;
  readonly eligibleTotal: bigint;
  readonly nettedTotal: bigint;
  readonly carryForward: bigint;
  readonly lineCount: number;
  readonly accountToken: string | null;
  readonly ibanLast4: string | null;
  readonly holdReason: HoldReason | null;
  readonly approvalId: string | null;
  readonly approvedBy: string | null;
  readonly approvedAtMs: number | null;
  readonly ledgerRef: string | null;
  readonly providerRef: string | null;
  readonly attempts: number;
  readonly failureCode: string | null;
  readonly sentAtMs: number | null;
  readonly settledAtMs: number | null;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly lines: readonly PayoutLineRecord[];
}

/** Who is reading or writing. The Kysely adapter maps it to RLS session settings. */
export type PayoutScope =
  | { readonly kind: "seller"; readonly userId: string; readonly storeIds: readonly string[] }
  | { readonly kind: "staff"; readonly userId: string; readonly role: "finance" | "ops" }
  | { readonly kind: "system" };

export type EventPayload = Readonly<Record<string, string | number | boolean | null>>;

export interface OutboxEventDraft {
  readonly id: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly occurredAtMs: number;
  readonly payload: EventPayload;
}

export interface NewPayout {
  readonly id: string;
  readonly storeId: string;
  readonly cycleKey: string;
  readonly cutoffAtMs: number;
  readonly amount: bigint;
  readonly eligibleTotal: bigint;
  readonly nettedTotal: bigint;
  readonly carryForward: bigint;
  readonly accountToken: string | null;
  readonly ibanLast4: string | null;
  readonly lines: readonly PayoutLineRecord[];
  readonly nowMs: number;
  readonly event: OutboxEventDraft;
}

export interface PayoutPatch {
  /** undefined keeps the stored value, null clears it. */
  readonly holdReason?: HoldReason | null;
  readonly approvalId?: string | null;
  readonly approvedBy?: string | null;
  readonly approvedAtMs?: number | null;
  readonly ledgerRef?: string | null;
  readonly providerRef?: string | null;
  readonly attempts?: number;
  readonly failureCode?: string | null;
  readonly sentAtMs?: number | null;
  readonly settledAtMs?: number | null;
}

export interface AttemptLog {
  readonly attemptNo: number;
  readonly outcome: "accepted" | "settled" | "rejected" | "unavailable";
  readonly code: string | null;
  readonly providerRef: string | null;
  readonly atMs: number;
}

export interface TransitionCommand {
  readonly payoutId: string;
  readonly expectedVersion: number;
  /** Unique per (payout, key). Callers prefix it with the command kind. */
  readonly commandKey: string;
  readonly from: PayoutState;
  readonly to: PayoutState;
  readonly event: PayoutEvent;
  readonly actorType: "SYSTEM" | "FINANCE";
  readonly actorId: string | null;
  readonly reasonCode: string | null;
  readonly nowMs: number;
  readonly historyId: string;
  readonly patch: PayoutPatch;
  readonly attempt?: AttemptLog;
  /** Cancelling gives the lines back to the next cycle. */
  readonly releaseLines: boolean;
  readonly events: readonly OutboxEventDraft[];
}

export type ApplyResult =
  | { readonly kind: "applied"; readonly payout: PayoutRecord }
  | { readonly kind: "replayed"; readonly payout: PayoutRecord }
  | { readonly kind: "conflict" }
  | { readonly kind: "not_found" };

export interface ListQuery {
  readonly scope: PayoutScope;
  readonly storeId?: string;
  readonly status?: PayoutState;
  readonly cycleKey?: string;
  readonly after: { readonly createdAtMs: number; readonly id: string } | null;
  readonly limit: number;
}

export interface ListPage {
  readonly items: readonly PayoutRecord[];
  readonly next: { readonly createdAtMs: number; readonly id: string } | null;
}

/** A ledger-relevant payout movement, derived from the append-only status history. */
export interface PayoutMovement {
  readonly payoutId: string;
  readonly kind: "payout" | "payout_reversal";
  readonly amount: bigint;
  readonly atMs: number;
  /** Unique per movement (history row id). */
  readonly id: string;
}

/** One state's totals for the finance summary (B-1). Windowed states count only rows changed since `sinceMs`. */
export interface PayoutStateTotals {
  readonly count: number;
  readonly amount: bigint;
  /** Oldest `updated_at` among the counted payouts ("last change": no state-entry timestamp exists). */
  readonly oldestUpdatedAtMs: number | null;
  readonly byHoldReason: Readonly<Record<string, number>>;
  readonly byFailureCode: Readonly<Record<string, number>>;
}

export interface PayoutStore {
  /** Totals per state, one read (no row walk). SETTLED and CANCELLED count only payouts updated at or after `windowSinceMs`. */
  /** Payout amounts of one store for the balance view: ON_HOLD and in transit (SCHEDULED, APPROVED, SENT, FAILED). One aggregate, scoped by RLS. */
  balanceTotals(scope: PayoutScope, storeId: string): Promise<{ readonly held: bigint; readonly inTransit: bigint }>;
  summaryByState(scope: PayoutScope, windowSinceMs: number): Promise<Readonly<Partial<Record<PayoutState, PayoutStateTotals>>>>;
  /** Idempotent on (store, cycle) while not CANCELLED. A duplicate writes nothing. */
  create(p: NewPayout): Promise<{ readonly kind: "created" | "duplicate"; readonly payout: PayoutRecord }>;
  /** Visible to the scope only (RLS plus filter). Others get null, so 404 and missing are alike. */
  get(id: string, scope: PayoutScope): Promise<PayoutRecord | null>;
  /** Store of a payout, for resolvers. System scope; reveals nothing to callers by itself. */
  locate(id: string): Promise<{ readonly storeId: string } | null>;
  list(q: ListQuery): Promise<ListPage>;
  activeSellerOrderIds(storeId: string): Promise<ReadonlySet<string>>;
  /** Sum of active clawback line amounts by clawback id. */
  appliedClawbacks(storeId: string): Promise<ReadonlyMap<string, bigint>>;
  movements(storeId: string): Promise<readonly PayoutMovement[]>;
  hasCommand(payoutId: string, commandKey: string): Promise<boolean>;
  apply(cmd: TransitionCommand): Promise<ApplyResult>;
  /** Logs a provider call that did not change the state (accepted, unavailable). */
  recordAttempt(payoutId: string, a: AttemptLog): Promise<void>;
  /** Payout ids in a state, oldest first (system scope, for jobs). */
  listIdsByStatus(status: PayoutState, limit: number): Promise<readonly string[]>;
}

// ------------------------------------------------------------------ ports to other modules

/** Read-only feed from the orders, refunds and disputes modules. A fake in this task. */
export interface PayoutSourcePort {
  /** Stores that have closed orders or outstanding clawbacks at the cutoff. Sorted. */
  storesWithPayables(cutoffMs: number): Promise<readonly string[]>;
  /** Closed and in-flight seller orders of the store with their seller-side net. */
  items(storeId: string, cutoffMs: number): Promise<readonly PayableItem[]>;
  /** Clawbacks with their FULL amount; the module subtracts what it already applied. */
  clawbacks(storeId: string): Promise<readonly Clawback[]>;
  /** Seller order ids (among `sellerOrderIds`) that have an open dispute right now. */
  openDisputes(sellerOrderIds: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface BankDetails {
  /** Opaque token resolving to the encrypted IBAN inside seller KYC. Never the IBAN. */
  readonly accountToken: string;
  readonly ibanLast4: string;
  /** Seller legal name as registered (commercial register). */
  readonly legalName: string;
}

export interface SellerBankPort {
  details(storeId: string): Promise<BankDetails | null>;
}

export type NameCheckOutcome = "matched" | "mismatch" | "unavailable";

/** Bank account-holder name inquiry against the seller's legal name (VERIFY: VR-F1-08). */
export interface IbanNameMatchPort {
  check(input: { readonly accountToken: string; readonly expectedLegalName: string }): Promise<NameCheckOutcome>;
}

export interface PayoutRiskPort {
  assess(input: { readonly storeId: string; readonly amount: bigint }): Promise<{ readonly hold: boolean }>;
}

/** Approval records of the admin module for a payout. Read-only. */
export interface PayoutApprovalsPort {
  forPayout(payoutId: string): Promise<readonly ApprovalRecord[]>;
}

export type LedgerPayoutResult = { readonly kind: "posted" | "replayed" };

/** Ledger-first. Idempotent on `ref` (payout id plus attempt). */
export interface PayoutLedgerPort {
  postPayout(input: {
    readonly ref: string;
    readonly storeId: string;
    readonly amount: bigint;
    readonly bankAccount: string;
  }): Promise<LedgerPayoutResult>;
  /** Mirrors the payout entry of `ref`. A second call returns `replayed`. */
  reversePayout(ref: string): Promise<LedgerPayoutResult>;
  /** True when a payout entry exists under `ref` (live or already reversed). Used by the R-5 sweeper. */
  hasPayoutEntry(ref: string): Promise<boolean>;
  /** Natural balance of seller_payable (positive = owed to the seller). */
  payableBalance(storeId: string): Promise<bigint>;
}

export type ProviderOutcome =
  | { readonly kind: "accepted"; readonly providerRef: string }
  | { readonly kind: "settled"; readonly providerRef: string }
  | { readonly kind: "rejected"; readonly code: string }
  | { readonly kind: "unavailable" };

/** PSP or bank payout rail (VERIFY: VR-F1-07). Idempotent on `idempotencyKey`. */
export interface PayoutPort {
  send(input: {
    readonly idempotencyKey: string;
    readonly amount: bigint;
    readonly accountToken: string;
    readonly reference: string;
  }): Promise<ProviderOutcome>;
}

export interface PayoutFlagsPort {
  /** Kill switch `payouts_enabled`. */
  payoutsEnabled(): Promise<boolean> | boolean;
}

/** Facts for seller statements, from orders, refunds and the ledger. Excludes payouts (this module owns them). */
export interface StatementSourcePort {
  facts(storeId: string, toMs: number): Promise<readonly StatementFact[]>;
}

export interface PayoutConfig {
  readonly cycle: { readonly weekday: number; readonly hour: number };
  readonly minimumPayoutMinor: bigint;
  readonly approval: ApprovalConfig;
  /** Ledger bank_settlement account name the payout leaves from. VERIFY (flow of funds). */
  readonly bankAccount: string;
}
