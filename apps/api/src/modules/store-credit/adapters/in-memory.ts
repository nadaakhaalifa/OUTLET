import type { HoldLivenessPort } from "../domain/ports";
import { createJournalEntry, planLotSpend, subBalanceKey, EXPIRING_PLATFORM_KINDS, type CreditLot, type JournalEntry, type Money } from "../domain/bridge";
import type {
  CreditLedgerPort,
  CreditTxn,
  HoldLine,
  HoldRecord,
  NewLot,
  PlaceHoldResult,
  StoreCreditStore,
} from "../domain/ports";

export class InMemoryStoreCredit implements StoreCreditStore {
  private readonly lots = new Map<string, CreditLot>();
  private readonly sources = new Set<string>();
  private readonly holds = new Map<string, HoldRecord>();
  private readonly txns: CreditTxn[] = [];
  private readonly dedupe = new Set<string>();
  /** Per-user tail of the hold queue: holds for one user run strictly one after another. */
  private readonly userQueue = new Map<string, Promise<unknown>>();

  private exclusive<T>(userId: string, run: () => Promise<T>): Promise<T> {
    const tail = this.userQueue.get(userId) ?? Promise.resolve();
    const next = tail.then(run, run);
    this.userQueue.set(
      userId,
      next.catch(() => undefined),
    );
    return next;
  }

  private pushTxn(t: CreditTxn): void {
    if (this.dedupe.has(t.dedupeKey)) return;
    this.dedupe.add(t.dedupeKey);
    this.txns.push(t);
  }

  async addLot(input: { lot: NewLot; txn: CreditTxn }): Promise<"added" | "exists"> {
    if (this.sources.has(input.lot.sourceKey)) return "exists";
    this.sources.add(input.lot.sourceKey);
    const { sourceKey: _s, ...lot } = input.lot;
    this.lots.set(lot.id, lot);
    this.pushTxn(input.txn);
    return "added";
  }

  async listLots(userId: string): Promise<readonly CreditLot[]> {
    return [...this.lots.values()]
      .filter((l) => l.userId === userId && l.remaining > 0n)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1));
  }

  placeHold(input: {
    id: string;
    userId: string;
    ref: string;
    amount: Money;
    nowMs: number;
    expiresAtMs: number;
  }): Promise<PlaceHoldResult> {
    return this.exclusive(input.userId, () => this.placeHoldNow(input));
  }

  private async placeHoldNow(input: {
    id: string;
    userId: string;
    ref: string;
    amount: Money;
    nowMs: number;
    expiresAtMs: number;
  }): Promise<PlaceHoldResult> {
    const key = `${input.userId}:${input.ref}`;
    const prior = this.holds.get(key);
    if (prior !== undefined) return { kind: "exists", hold: prior };
    const lots = await this.listLots(input.userId);
    let takes;
    try {
      takes = planLotSpend(lots, input.amount, input.nowMs);
    } catch {
      const available = lots.reduce(
        (a, l) => a + (l.expiresAtMs !== null && l.expiresAtMs <= input.nowMs ? 0n : l.remaining - l.held),
        0n,
      );
      return { kind: "insufficient", available };
    }
    const lines: HoldLine[] = takes.map((t) => ({ lotId: t.lotId, sub: t.sub, amount: t.amount.amount }));
    for (const l of lines) {
      const lot = this.lots.get(l.lotId);
      if (lot !== undefined) this.lots.set(l.lotId, { ...lot, held: lot.held + l.amount });
    }
    const hold: HoldRecord = {
      id: input.id,
      userId: input.userId,
      ref: input.ref,
      status: "held",
      amount: input.amount.amount,
      expiresAtMs: input.expiresAtMs,
      orderEntryKey: null,
      createdAtMs: input.nowMs,
      resolvedAtMs: null,
      lines,
    };
    this.holds.set(key, hold);
    return { kind: "held", hold };
  }

  async getHold(userId: string, ref: string): Promise<HoldRecord | null> {
    return this.holds.get(`${userId}:${ref}`) ?? null;
  }

  async releaseHold(userId: string, ref: string, nowMs: number): Promise<"released" | "not_found" | "not_held"> {
    const key = `${userId}:${ref}`;
    const h = this.holds.get(key);
    if (h === undefined) return "not_found";
    if (h.status !== "held") return "not_held";
    for (const l of h.lines) {
      const lot = this.lots.get(l.lotId);
      if (lot !== undefined) this.lots.set(l.lotId, { ...lot, held: lot.held - l.amount });
    }
    this.holds.set(key, { ...h, status: "released", resolvedAtMs: nowMs });
    return "released";
  }

  async captureHold(input: { userId: string; ref: string; orderEntryKey: string; nowMs: number }) {
    const key = `${input.userId}:${input.ref}`;
    const h = this.holds.get(key);
    if (h === undefined) return { kind: "not_found" as const };
    // Replay of the same capture (same order entry) is a success, not a loss of the hold.
    if (h.status === "captured" && h.orderEntryKey === input.orderEntryKey) return { kind: "captured" as const, hold: h };
    if (h.status !== "held") return { kind: "not_held" as const };
    for (const l of h.lines) {
      const lot = this.lots.get(l.lotId);
      if (lot === undefined) continue;
      this.lots.set(l.lotId, { ...lot, held: lot.held - l.amount, remaining: lot.remaining - l.amount });
      this.pushTxn({
        id: `used-${h.id}-${l.lotId}`,
        userId: h.userId,
        kind: "credit_used",
        reason: "order",
        sub: l.sub,
        amount: l.amount,
        ref: input.ref,
        dedupeKey: `used:${h.id}:${l.lotId}`,
        createdAtMs: input.nowMs,
      });
    }
    const captured: HoldRecord = { ...h, status: "captured", orderEntryKey: input.orderEntryKey, resolvedAtMs: input.nowMs };
    this.holds.set(key, captured);
    return { kind: "captured" as const, hold: captured };
  }

  async listExpiredHolds(nowMs: number, limit: number): Promise<readonly HoldRecord[]> {
    return [...this.holds.values()]
      .filter((h) => h.status === "held" && h.expiresAtMs <= nowMs)
      .sort((a, b) => a.expiresAtMs - b.expiresAtMs || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }

  async listSweepable(nowMs: number, limit: number): Promise<readonly CreditLot[]> {
    return [...this.lots.values()]
      .filter(
        (l) =>
          l.remaining > 0n &&
          l.held === 0n &&
          l.expiresAtMs !== null &&
          l.expiresAtMs <= nowMs &&
          EXPIRING_PLATFORM_KINDS.includes(l.sub.kind),
      )
      .sort((a, b) => (a.expiresAtMs ?? 0) - (b.expiresAtMs ?? 0) || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }

  async expireLot(input: { lotId: string; txn: CreditTxn }): Promise<"expired" | "stale"> {
    const lot = this.lots.get(input.lotId);
    if (lot === undefined || lot.remaining === 0n || lot.held !== 0n) return "stale";
    this.lots.set(lot.id, { ...lot, remaining: 0n });
    this.pushTxn(input.txn);
    return "expired";
  }

  async listTransactions(
    userId: string,
    page: { after: { createdAtMs: number; id: string } | null; limit: number },
  ): Promise<readonly CreditTxn[]> {
    const rows = this.txns
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1));
    const after = page.after;
    const start =
      after === null
        ? 0
        : rows.findIndex((t) => t.createdAtMs < after.createdAtMs || (t.createdAtMs === after.createdAtMs && t.id < after.id));
    return start < 0 ? [] : rows.slice(start, start + page.limit);
  }

  async listUserIds(after: string | null, limit: number): Promise<readonly string[]> {
    const ids = [...new Set([...this.lots.values()].map((l) => l.userId))].sort();
    return ids.filter((i) => after === null || i > after).slice(0, limit);
  }

  async listCaptured(userId: string) {
    const out: { subKey: string; amount: bigint; orderEntryKey: string }[] = [];
    for (const h of this.holds.values()) {
      if (h.userId !== userId || h.status !== "captured" || h.orderEntryKey === null) continue;
      for (const l of h.lines) out.push({ subKey: subBalanceKey(l.sub), amount: l.amount, orderEntryKey: h.orderEntryKey });
    }
    return out;
  }
}

/** Ledger fake: idempotent by key, derives balances from postings. */
export class InMemoryCreditLedger implements CreditLedgerPort {
  readonly entries = new Map<string, JournalEntry>();
  async post(entry: JournalEntry): Promise<{ kind: "posted" | "replayed" }> {
    const prior = this.entries.get(entry.idempotencyKey);
    if (prior !== undefined) return { kind: "replayed" };
    this.entries.set(entry.idempotencyKey, createJournalEntry(entry));
    return { kind: "posted" };
  }
  async balances(userId: string): Promise<ReadonlyMap<string, bigint>> {
    const prefix = `store_credit:${userId}:`;
    const out = new Map<string, bigint>();
    for (const e of this.entries.values()) {
      for (const p of e.postings) {
        if (!p.account.startsWith(prefix)) continue;
        const k = p.account.slice(prefix.length);
        out.set(k, (out.get(k) ?? 0n) - p.amount.amount);
      }
    }
    return out;
  }
  async hasEntry(key: string): Promise<boolean> {
    return this.entries.has(key);
  }
}

/** Dev fake for the sweeper guard: live refs are registered by the test or the dev composition. */
export class InMemoryHoldLiveness implements HoldLivenessPort {
  readonly live = new Set<string>();
  async isLive(holdRef: string): Promise<boolean> {
    return this.live.has(holdRef);
  }
}
