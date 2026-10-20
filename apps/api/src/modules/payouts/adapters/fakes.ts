import {
  buildEntry,
  buildReversal,
  namesMatch,
  type ApprovalRecord,
  type Clawback,
  type JournalEntry,
  type PayableItem,
  type StatementFact,
  money,
} from "../domain/bridge";
import type {
  BankDetails,
  IbanNameMatchPort,
  LedgerPayoutResult,
  NameCheckOutcome,
  PayoutApprovalsPort,
  PayoutFlagsPort,
  PayoutLedgerPort,
  PayoutPort,
  PayoutRiskPort,
  PayoutSourcePort,
  ProviderOutcome,
  SellerBankPort,
  StatementSourcePort,
} from "../domain/ports";

/** Order, refund and dispute facts held in memory. Production reads the orders and refunds modules. */
export class FakePayoutSource implements PayoutSourcePort, StatementSourcePort {
  readonly itemsByStore = new Map<string, PayableItem[]>();
  readonly clawbacksByStore = new Map<string, Clawback[]>();
  readonly disputes = new Set<string>();
  readonly statementFacts = new Map<string, StatementFact[]>();

  addItem(i: PayableItem): void {
    this.itemsByStore.set(i.storeId, [...(this.itemsByStore.get(i.storeId) ?? []), i]);
  }
  addClawback(c: Clawback): void {
    this.clawbacksByStore.set(c.storeId, [...(this.clawbacksByStore.get(c.storeId) ?? []), c]);
  }
  async storesWithPayables(): Promise<readonly string[]> {
    return [...new Set([...this.itemsByStore.keys(), ...this.clawbacksByStore.keys()])].sort();
  }
  async items(storeId: string): Promise<readonly PayableItem[]> {
    return (this.itemsByStore.get(storeId) ?? []).map((i) => ({ ...i, openDispute: i.openDispute || this.disputes.has(i.sellerOrderId) }));
  }
  async clawbacks(storeId: string): Promise<readonly Clawback[]> {
    return this.clawbacksByStore.get(storeId) ?? [];
  }
  async openDisputes(ids: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set(ids.filter((i) => this.disputes.has(i)));
  }
  async facts(storeId: string): Promise<readonly StatementFact[]> {
    return this.statementFacts.get(storeId) ?? [];
  }
}

export class FakeSellerBank implements SellerBankPort {
  readonly byStore = new Map<string, BankDetails>();
  /** What the "bank" reports as account holder, by account token. */
  readonly holders = new Map<string, string>();
  async details(storeId: string): Promise<BankDetails | null> {
    return this.byStore.get(storeId) ?? null;
  }
}

/** Uses the fake bank's holder names and the domain's strict name comparison. */
export class FakeIbanNameMatch implements IbanNameMatchPort {
  outage = false;
  constructor(private readonly bank: FakeSellerBank) {}
  async check(input: { accountToken: string; expectedLegalName: string }): Promise<NameCheckOutcome> {
    if (this.outage) return "unavailable";
    const holder = this.bank.holders.get(input.accountToken);
    if (holder === undefined) return "unavailable";
    return namesMatch(holder, input.expectedLegalName) === "match" ? "matched" : "mismatch";
  }
}

export class FakePayoutRisk implements PayoutRiskPort {
  readonly held = new Set<string>();
  async assess(i: { storeId: string }): Promise<{ hold: boolean }> {
    return { hold: this.held.has(i.storeId) };
  }
}

export class FakeApprovals implements PayoutApprovalsPort {
  readonly records: ApprovalRecord[] = [];
  async forPayout(payoutId: string): Promise<readonly ApprovalRecord[]> {
    return this.records.filter((r) => r.subjectType === "payout" && r.subjectId === payoutId);
  }
}

export class FakeFlags implements PayoutFlagsPort {
  enabled = true;
  payoutsEnabled(): boolean {
    return this.enabled;
  }
}

/**
 * Ledger fake that builds the REAL balanced entries with the domain templates, so tests can read
 * balances. Idempotent on the ref, like the posting service's idempotency key.
 */
export class FakePayoutLedger implements PayoutLedgerPort {
  readonly entries = new Map<string, JournalEntry>();
  readonly reversals = new Map<string, JournalEntry>();
  readonly balances = new Map<string, bigint>();
  private seq = 0;

  setBalance(storeId: string, natural: bigint): void {
    this.balances.set(storeId, natural);
  }

  async postPayout(i: { ref: string; storeId: string; amount: bigint; bankAccount: string }): Promise<LedgerPayoutResult> {
    const existing = this.entries.get(i.ref);
    if (existing !== undefined) return { kind: "replayed" };
    this.seq += 1;
    const entry = buildEntry(
      { type: "seller_payout", payoutId: i.ref, storeId: i.storeId, amount: money(i.amount), bankAccount: i.bankAccount },
      { id: `00000000-0000-4000-8000-${String(700_000 + this.seq).padStart(12, "0")}`, occurredAt: new Date(0) },
    );
    this.entries.set(i.ref, entry);
    this.balances.set(i.storeId, (this.balances.get(i.storeId) ?? 0n) - i.amount);
    return { kind: "posted" };
  }

  async reversePayout(ref: string): Promise<LedgerPayoutResult> {
    const original = this.entries.get(ref);
    if (original === undefined) throw new Error(`no payout entry for ${ref}`);
    if (this.reversals.has(ref)) return { kind: "replayed" };
    this.seq += 1;
    this.reversals.set(
      ref,
      buildReversal(original, {
        id: `00000000-0000-4000-8000-${String(700_000 + this.seq).padStart(12, "0")}`,
        occurredAt: new Date(0),
      }),
    );
    const amount = original.postings.reduce((a, p) => (p.amount.amount > 0n ? a + p.amount.amount : a), 0n);
    const store = original.postings.find((p) => p.account.startsWith("seller_payable:"))?.account.slice("seller_payable:".length);
    if (store !== undefined) this.balances.set(store, (this.balances.get(store) ?? 0n) + amount);
    return { kind: "posted" };
  }

  async hasPayoutEntry(ref: string): Promise<boolean> {
    return this.entries.has(ref);
  }

  async payableBalance(storeId: string): Promise<bigint> {
    return this.balances.get(storeId) ?? 0n;
  }

  /** Entries posted and not reversed. */
  liveEntries(): JournalEntry[] {
    return [...this.entries].filter(([ref]) => !this.reversals.has(ref)).map(([, e]) => e);
  }
}

export type FakeProviderMode = "settle" | "accept" | "reject" | "unavailable";

/** Idempotent by key: the first outcome is remembered until a test moves it with `resolve`. */
export class FakePayoutPort implements PayoutPort {
  mode: FakeProviderMode = "accept";
  rejectCode = "account_closed";
  readonly byKey = new Map<string, ProviderOutcome>();
  readonly calls: string[] = [];
  /** Distinct keys the provider actually executed (a replay is not a second payment). */
  readonly executed: { key: string; amount: bigint; accountToken: string }[] = [];

  async send(i: { idempotencyKey: string; amount: bigint; accountToken: string; reference: string }): Promise<ProviderOutcome> {
    this.calls.push(i.idempotencyKey);
    const seen = this.byKey.get(i.idempotencyKey);
    if (seen !== undefined && seen.kind !== "unavailable") return seen;
    let out: ProviderOutcome;
    switch (this.mode) {
      case "settle":
        out = { kind: "settled", providerRef: `fake-${i.idempotencyKey}` };
        break;
      case "accept":
        out = { kind: "accepted", providerRef: `fake-${i.idempotencyKey}` };
        break;
      case "reject":
        out = { kind: "rejected", code: this.rejectCode };
        break;
      case "unavailable":
        return { kind: "unavailable" };
    }
    if (!this.byKey.has(i.idempotencyKey)) this.executed.push({ key: i.idempotencyKey, amount: i.amount, accountToken: i.accountToken });
    this.byKey.set(i.idempotencyKey, out);
    return out;
  }

  /** Moves an accepted payout to its final state, as the bank would later. */
  resolve(key: string, to: "settled" | "rejected"): void {
    this.byKey.set(key, to === "settled" ? { kind: "settled", providerRef: `fake-${key}` } : { kind: "rejected", code: this.rejectCode });
  }
}
