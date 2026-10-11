import { createJournalEntry, type JournalEntry } from "../domain/bridge";
import type {
  CreditRestorePort,
  ExecutionOutcome,
  ExecutionRequest,
  JitterPort,
  LedgerPostResult,
  PayoutDetailsPort,
  RefundExecutionPort,
  RefundFactsPort,
  RefundFacts,
  RefundLedgerPort,
} from "../domain/ports";

/** In-repo ledger fake: idempotent by key, rejects the same key with different postings. */
export class InMemoryRefundLedger implements RefundLedgerPort {
  readonly entries = new Map<string, JournalEntry>();
  /** Keys of recognition entries that exist (the real ledger holds them as order_paid / order_cod_confirmed). */
  readonly recognised = new Set<string>();
  failNext = 0;

  /** Marks an order group's recognition entry as present. */
  recognise(orderGroupId: string): void {
    this.recognised.add(`order_paid:${orderGroupId}`);
  }

  async hasEntry(key: string): Promise<boolean> {
    return this.recognised.has(key) || this.entries.has(key);
  }

  async post(entry: JournalEntry): Promise<LedgerPostResult> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("ledger unavailable");
    }
    const prior = this.entries.get(entry.idempotencyKey);
    if (prior !== undefined) {
      const same =
        prior.postings.length === entry.postings.length &&
        prior.postings.every((p, i) => p.account === entry.postings[i]?.account && p.amount.amount === entry.postings[i]?.amount.amount);
      if (!same) throw new Error(`idempotency key ${entry.idempotencyKey} reused with different postings`);
      return { kind: "replayed" };
    }
    this.entries.set(entry.idempotencyKey, createJournalEntry(entry));
    return { kind: "posted" };
  }
}

export class FakeRefundFacts implements RefundFactsPort {
  private readonly bySellerOrder = new Map<string, RefundFacts>();
  seed(sellerOrderId: string, facts: RefundFacts): void {
    this.bySellerOrder.set(sellerOrderId, facts);
  }
  async forSellerOrder(sellerOrderId: string): Promise<RefundFacts | null> {
    return this.bySellerOrder.get(sellerOrderId) ?? null;
  }
}

export class FakePayoutDetails implements PayoutDetailsPort {
  private readonly ok = new Set<string>();
  verify(userId: string, channel: "bank_transfer_iban" | "wallet_transfer"): void {
    this.ok.add(`${userId}:${channel}`);
  }
  async verified(userId: string, channel: "bank_transfer_iban" | "wallet_transfer"): Promise<boolean> {
    return this.ok.has(`${userId}:${channel}`);
  }
}

export class FakeCreditRestore implements CreditRestorePort {
  readonly restored = new Map<string, { userId: string; sub: string; amount: bigint; refundId: string }>();
  failNext = 0;
  async restore(input: Parameters<CreditRestorePort["restore"]>[0]): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("store credit unavailable");
    }
    if (this.restored.has(input.legId)) return;
    this.restored.set(input.legId, {
      userId: input.userId,
      sub: input.sub.kind,
      amount: input.amount.amount,
      refundId: input.refundId,
    });
  }
}

/** Scripted provider fake. No network. Default: confirmed with a deterministic reference. */
export class FakeRefundExecutor implements RefundExecutionPort {
  readonly calls: ExecutionRequest[] = [];
  private readonly script = new Map<string, (ExecutionOutcome | "throw")[]>();
  /** Provider-side idempotency: the same key returns the first outcome that was confirmed. */
  private readonly settled = new Map<string, ExecutionOutcome>();

  scriptFor(idempotencyKey: string, ...outcomes: (ExecutionOutcome | "throw")[]): void {
    this.script.set(idempotencyKey, outcomes);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.calls.push(request);
    const done = this.settled.get(request.idempotencyKey);
    if (done !== undefined) return done;
    const next = this.script.get(request.idempotencyKey)?.shift();
    if (next === "throw") throw new Error("provider timeout");
    const outcome: ExecutionOutcome = next ?? { kind: "confirmed", providerRef: `fake-${request.idempotencyKey}` };
    if (outcome.kind === "confirmed") this.settled.set(request.idempotencyKey, outcome);
    return outcome;
  }
}

export interface RecordedFixture {
  readonly channel: ExecutionRequest["channel"];
  readonly method?: ExecutionRequest["method"];
  readonly outcome: ExecutionOutcome;
}

/**
 * Replays recorded provider responses. The recordings are SYNTHETIC until a provider contract and
 * sandbox exist (VERIFY VR-RF-08): the shapes are assumptions, not Paymob documentation.
 */
export class RecordedFixtureRefundExecutor implements RefundExecutionPort {
  constructor(private readonly fixtures: readonly RecordedFixture[]) {}
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    const hit = this.fixtures.find(
      (f) => f.channel === request.channel && (f.method === undefined || f.method === request.method),
    );
    if (hit === undefined) throw new Error(`no recorded fixture for ${request.channel}/${request.method}`);
    return hit.outcome.kind === "rejected"
      ? hit.outcome
      : { kind: hit.outcome.kind, providerRef: `${hit.outcome.providerRef}:${request.idempotencyKey}` };
  }
}

export class SeqJitter implements JitterPort {
  constructor(private v = 0.5) {}
  next(): number {
    return this.v;
  }
}
