import type { Clock } from "../../../platform/ports";
import type {
  ApplyResult,
  AttemptLog,
  ListPage,
  ListQuery,
  NewPayout,
  OutboxEventDraft,
  PayoutMovement,
  PayoutRecord,
  PayoutScope,
  PayoutStore,
  TransitionCommand,
} from "../domain/ports";

type Mutable = { -readonly [K in keyof PayoutRecord]: PayoutRecord[K] };
interface HistoryRow {
  readonly id: string;
  readonly payoutId: string;
  readonly storeId: string;
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly commandKey: string;
  readonly atMs: number;
}
interface LineRow {
  readonly payoutId: string;
  readonly storeId: string;
  readonly sourceType: "seller_order" | "clawback";
  readonly sourceId: string;
  readonly amount: bigint;
  active: boolean;
}

const TERMINAL: ReadonlySet<string> = new Set(["SETTLED", "CANCELLED"]);

/** In-memory PayoutStore with the same observable behaviour as the Postgres adapter (shared contract suite). */
export class InMemoryPayoutStore implements PayoutStore {
  private readonly payouts = new Map<string, Mutable>();
  private readonly lines: LineRow[] = [];
  readonly history: HistoryRow[] = [];
  readonly attempts: (AttemptLog & { payoutId: string })[] = [];
  readonly outbox: OutboxEventDraft[] = [];

  constructor(private readonly clock: Clock) {}

  private view(p: Mutable): PayoutRecord {
    return {
      ...p,
      lines: this.lines
        .filter((l) => l.payoutId === p.id)
        .map((l) => ({ sourceType: l.sourceType, sourceId: l.sourceId, amount: l.amount })),
    };
  }

  private visible(p: Mutable, scope: PayoutScope): boolean {
    if (scope.kind === "system" || scope.kind === "staff") return true;
    return scope.storeIds.includes(p.storeId);
  }

  async create(n: NewPayout): Promise<{ kind: "created" | "duplicate"; payout: PayoutRecord }> {
    for (const p of this.payouts.values()) {
      if (p.storeId === n.storeId && p.cycleKey === n.cycleKey && p.status !== "CANCELLED") {
        return { kind: "duplicate", payout: this.view(p) };
      }
    }
    for (const l of n.lines) {
      if (l.sourceType === "seller_order" && this.lines.some((x) => x.active && x.sourceType === "seller_order" && x.sourceId === l.sourceId)) {
        throw new Error(`seller order ${l.sourceId} is already in an active payout`);
      }
    }
    const rec: Mutable = {
      id: n.id,
      storeId: n.storeId,
      cycleKey: n.cycleKey,
      cutoffAtMs: n.cutoffAtMs,
      status: "SCHEDULED",
      amount: n.amount,
      eligibleTotal: n.eligibleTotal,
      nettedTotal: n.nettedTotal,
      carryForward: n.carryForward,
      lineCount: n.lines.length,
      accountToken: n.accountToken,
      ibanLast4: n.ibanLast4,
      holdReason: null,
      approvalId: null,
      approvedBy: null,
      approvedAtMs: null,
      ledgerRef: null,
      providerRef: null,
      attempts: 0,
      failureCode: null,
      sentAtMs: null,
      settledAtMs: null,
      version: 0,
      createdAtMs: n.nowMs,
      updatedAtMs: n.nowMs,
      lines: [],
    };
    this.payouts.set(rec.id, rec);
    for (const l of n.lines) {
      this.lines.push({ payoutId: n.id, storeId: n.storeId, sourceType: l.sourceType, sourceId: l.sourceId, amount: l.amount, active: true });
    }
    this.outbox.push(n.event);
    return { kind: "created", payout: this.view(rec) };
  }

  async get(id: string, scope: PayoutScope): Promise<PayoutRecord | null> {
    const p = this.payouts.get(id);
    return p === undefined || !this.visible(p, scope) ? null : this.view(p);
  }

  async locate(id: string): Promise<{ storeId: string } | null> {
    const p = this.payouts.get(id);
    return p === undefined ? null : { storeId: p.storeId };
  }

  async list(q: ListQuery): Promise<ListPage> {
    const rows = [...this.payouts.values()]
      .filter((p) => this.visible(p, q.scope))
      .filter((p) => q.storeId === undefined || p.storeId === q.storeId)
      .filter((p) => q.status === undefined || p.status === q.status)
      .filter((p) => q.cycleKey === undefined || p.cycleKey === q.cycleKey)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1))
      .filter(
        (p) =>
          q.after === null ||
          p.createdAtMs < q.after.createdAtMs ||
          (p.createdAtMs === q.after.createdAtMs && p.id < q.after.id),
      );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((p) => this.view(p)),
      next: rows.length > q.limit && last !== undefined ? { createdAtMs: last.createdAtMs, id: last.id } : null,
    };
  }

  async activeSellerOrderIds(storeId: string): Promise<ReadonlySet<string>> {
    return new Set(this.lines.filter((l) => l.active && l.storeId === storeId && l.sourceType === "seller_order").map((l) => l.sourceId));
  }

  async appliedClawbacks(storeId: string): Promise<ReadonlyMap<string, bigint>> {
    const m = new Map<string, bigint>();
    for (const l of this.lines) {
      if (l.active && l.storeId === storeId && l.sourceType === "clawback") m.set(l.sourceId, (m.get(l.sourceId) ?? 0n) + l.amount);
    }
    return m;
  }

  async movements(storeId: string): Promise<readonly PayoutMovement[]> {
    const out: PayoutMovement[] = [];
    for (const h of this.history) {
      if (h.storeId !== storeId) continue;
      const p = this.payouts.get(h.payoutId);
      if (p === undefined) continue;
      if (h.event === "SEND") out.push({ payoutId: h.payoutId, kind: "payout", amount: p.amount, atMs: h.atMs, id: h.id });
      else if (h.event === "BANK_REJECTED") {
        out.push({ payoutId: h.payoutId, kind: "payout_reversal", amount: p.amount, atMs: h.atMs, id: h.id });
      }
    }
    return out;
  }

  async hasCommand(payoutId: string, commandKey: string): Promise<boolean> {
    return this.history.some((h) => h.payoutId === payoutId && h.commandKey === commandKey);
  }

  async apply(c: TransitionCommand): Promise<ApplyResult> {
    const p = this.payouts.get(c.payoutId);
    if (p === undefined) return { kind: "not_found" };
    if (await this.hasCommand(c.payoutId, c.commandKey)) return { kind: "replayed", payout: this.view(p) };
    if (p.version !== c.expectedVersion || p.status !== c.from) return { kind: "conflict" };
    if (TERMINAL.has(p.status) && p.status !== c.to) throw new Error(`payout ${p.id} is in terminal state ${p.status}`);
    const t = c.patch;
    p.status = c.to;
    p.version += 1;
    p.updatedAtMs = c.nowMs;
    if (t.holdReason !== undefined) p.holdReason = t.holdReason;
    if (t.approvalId !== undefined) p.approvalId = t.approvalId;
    if (t.approvedBy !== undefined) p.approvedBy = t.approvedBy;
    if (t.approvedAtMs !== undefined) p.approvedAtMs = t.approvedAtMs;
    if (t.ledgerRef !== undefined) p.ledgerRef = t.ledgerRef;
    if (t.providerRef !== undefined) p.providerRef = t.providerRef;
    if (t.attempts !== undefined) p.attempts = t.attempts;
    if (t.failureCode !== undefined) p.failureCode = t.failureCode;
    if (t.sentAtMs !== undefined) p.sentAtMs = t.sentAtMs;
    if (t.settledAtMs !== undefined) p.settledAtMs = t.settledAtMs;
    if (c.releaseLines) for (const l of this.lines) if (l.payoutId === p.id) l.active = false;
    this.history.push({
      id: c.historyId,
      payoutId: p.id,
      storeId: p.storeId,
      from: c.from,
      to: c.to,
      event: c.event,
      commandKey: c.commandKey,
      atMs: c.nowMs,
    });
    if (c.attempt !== undefined) this.attempts.push({ ...c.attempt, payoutId: p.id });
    this.outbox.push(...c.events);
    return { kind: "applied", payout: this.view(p) };
  }

  async recordAttempt(payoutId: string, a: AttemptLog): Promise<void> {
    const p = this.payouts.get(payoutId);
    if (p === undefined) return;
    this.attempts.push({ ...a, payoutId });
    if (a.providerRef !== null) p.providerRef = a.providerRef;
  }

  async listIdsByStatus(status: PayoutRecord["status"], limit: number): Promise<readonly string[]> {
    return [...this.payouts.values()]
      .filter((p) => p.status === status)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((p) => p.id);
  }

  /** Test hook: clock the store was built with. */
  now(): number {
    return this.clock.nowMs();
  }
}
