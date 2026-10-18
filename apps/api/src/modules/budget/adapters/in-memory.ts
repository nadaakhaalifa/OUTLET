import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { PlanItem, SpendEvent } from "../domain/bridge";
import type {
  BagTotalPort,
  BudgetConsentPort,
  BudgetEvent,
  BudgetFlagsPort,
  BudgetRecord,
  BudgetStore,
  BudgetTx,
  CommitmentRecord,
  CycleRecord,
  FieldCipherPort,
  GoalRecord,
  OrderSpendSourcePort,
  SpendEventRecord,
  UnlockRequestRecord,
  WishlistPlanSourcePort,
} from "../domain/ports";

export class ReadOnlyTransactionError extends Error {
  constructor() {
    super("write attempted in a read-only budget transaction");
    this.name = "ReadOnlyTransactionError";
  }
}

interface UserState {
  budget: BudgetRecord | null;
  cycles: Map<number, CycleRecord>;
  events: Map<string, SpendEventRecord>;
  commitments: CommitmentRecord[];
  goals: GoalRecord[];
  unlocks: UnlockRequestRecord[];
}

const empty = (): UserState => ({ budget: null, cycles: new Map(), events: new Map(), commitments: [], goals: [], unlocks: [] });
const copy = (s: UserState): UserState => ({
  budget: s.budget,
  cycles: new Map(s.cycles),
  events: new Map(s.events),
  commitments: [...s.commitments],
  goals: [...s.goals],
  unlocks: [...s.unlocks],
});

const commitmentKey = (c: CommitmentRecord): string => `${c.source}|${c.provider}|${c.startsAtMs}`;

/** In-memory reference adapter. Same contract suite as the Kysely store (test/repository-contract.ts). */
export class InMemoryBudgetStore implements BudgetStore {
  private readonly users = new Map<string, UserState>();
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Committed outbox events, in order. */
  readonly events: BudgetEvent[] = [];
  /** Number of committed write transactions (read-only transactions never increment it). */
  writes = 0;
  /** Test hook: make the next `run` fail like a database outage. */
  failing = false;

  private tx(state: UserState, readOnly: boolean, out: BudgetEvent[]): BudgetTx {
    const w = <T>(fn: () => T): T => {
      if (readOnly) throw new ReadOnlyTransactionError();
      return fn();
    };
    return {
      getBudget: async () => state.budget,
      putBudget: async (r) => w(() => void (state.budget = r)),
      getCycle: async (s) => state.cycles.get(s) ?? null,
      putCycle: async (r) =>
        w(() => {
          const had = state.cycles.has(r.startMs);
          state.cycles.set(r.startMs, r);
          return had ? ("updated" as const) : ("inserted" as const);
        }),
      listSpendEvents: async (since) =>
        [...state.events.values()]
          .filter((e) => e.orderPlacedAtMs >= since || e.occurredAtMs >= since)
          .sort((a, b) => a.occurredAtMs - b.occurredAtMs || (a.key < b.key ? -1 : 1)),
      insertSpendEvent: async (r) =>
        w(() => {
          if (state.events.has(r.key)) return "exists" as const;
          state.events.set(r.key, r);
          return "inserted" as const;
        }),
      deleteSpendEvent: async (key) => w(() => state.events.delete(key)),
      listCommitments: async () => [...state.commitments],
      replaceCommitments: async (source, records) =>
        w(() => {
          const kept = state.commitments.filter((c) => c.source !== source);
          const seen = new Set<string>();
          const next = records.filter((r) => (seen.has(commitmentKey(r)) ? false : (seen.add(commitmentKey(r)), true)));
          state.commitments = [...kept, ...next];
        }),
      listGoals: async () => [...state.goals],
      insertUnlockRequest: async (r) => w(() => void state.unlocks.push(r)),
      latestUnlockRequest: async () => [...state.unlocks].sort((a, b) => b.requestedAtMs - a.requestedAtMs)[0] ?? null,
      listCycles: async (limit) => [...state.cycles.values()].sort((a, b) => b.startMs - a.startMs).slice(0, limit),
      deleteAll: async () =>
        w(() => {
          let n = 0;
          if (state.budget !== null) n += 1;
          if (state.cycles.size > 0) n += 1;
          if (state.events.size > 0) n += 1;
          if (state.commitments.length > 0) n += 1;
          if (state.goals.length > 0) n += 1;
          if (state.unlocks.length > 0) n += 1;
          Object.assign(state, empty());
          return n;
        }),
      emit: async (e) => w(() => void out.push(...e)),
    };
  }

  async run<T>(userId: string, fn: (tx: BudgetTx) => Promise<T>): Promise<T> {
    const prev = this.chains.get(userId) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (this.failing) throw new Error("budget store unavailable");
      const base = this.users.get(userId) ?? empty();
      const work = copy(base);
      const out: BudgetEvent[] = [];
      const result = await fn(this.tx(work, false, out));
      this.users.set(userId, work);
      this.events.push(...out);
      this.writes += 1;
      return result;
    });
    this.chains.set(
      userId,
      next.catch(() => undefined),
    );
    return next;
  }

  async read<T>(userId: string, fn: (tx: BudgetTx) => Promise<T>): Promise<T> {
    if (this.failing) throw new Error("budget store unavailable");
    return fn(this.tx(copy(this.users.get(userId) ?? empty()), true, []));
  }

  async usersWithBudget(after: string | null, limit: number): Promise<readonly string[]> {
    return [...this.users.entries()]
      .filter(([, s]) => s.budget !== null)
      .map(([id]) => id)
      .filter((id) => after === null || id > after)
      .sort()
      .slice(0, limit);
  }

  /** Test helper: is anything stored for the user. */
  hasAnyData(userId: string): boolean {
    const s = this.users.get(userId);
    return s !== undefined && (s.budget !== null || s.cycles.size > 0 || s.events.size > 0 || s.commitments.length > 0 || s.goals.length > 0 || s.unlocks.length > 0);
  }
}

// ---- fakes for ports owned by other modules ---------------------------------------------------

/**
 * DEVELOPMENT FIXTURE. Real AES-256-GCM with a process-local random key so ciphertext is opaque in
 * tests, but the key is not managed or rotated. Production wires a KMS envelope cipher (spec T5).
 */
export class DevAesGcmFieldCipher implements FieldCipherPort {
  private failing = false;
  constructor(private readonly key: Buffer = randomBytes(32)) {}
  setFailing(v: boolean): void {
    this.failing = v;
  }
  async encrypt(plaintext: Uint8Array, aad: string): Promise<Uint8Array> {
    if (this.failing) throw new Error("kms unavailable");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(aad, "utf8"));
    const body = Buffer.concat([c.update(plaintext), c.final()]);
    return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), body]));
  }
  async decrypt(ciphertext: Uint8Array, aad: string): Promise<Uint8Array> {
    if (this.failing) throw new Error("kms unavailable");
    const buf = Buffer.from(ciphertext);
    const d = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12), { authTagLength: 16 });
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(buf.subarray(12, 28));
    return new Uint8Array(Buffer.concat([d.update(buf.subarray(28)), d.final()]));
  }
}

export class FakeBudgetConsent implements BudgetConsentPort {
  private readonly granted = new Set<string>();
  async isGranted(userId: string): Promise<boolean> {
    return this.granted.has(userId);
  }
  grant(userId: string): void {
    this.granted.add(userId);
  }
  withdraw(userId: string): void {
    this.granted.delete(userId);
  }
}

export class FakeOrderSpendSource implements OrderSpendSourcePort {
  private readonly byUser = new Map<string, SpendEvent[]>();
  add(userId: string, e: SpendEvent): void {
    this.byUser.set(userId, [...(this.byUser.get(userId) ?? []), e]);
  }
  async listSpend(userId: string, fromMs: number, toMs: number): Promise<readonly SpendEvent[]> {
    return (this.byUser.get(userId) ?? []).filter(
      (e) => (e.orderPlacedAtMs >= fromMs && e.orderPlacedAtMs <= toMs) || (e.occurredAtMs >= fromMs && e.occurredAtMs <= toMs),
    );
  }
}

export class FakeBagTotal implements BagTotalPort {
  private readonly totals = new Map<string, bigint>();
  set(userId: string, total: bigint): void {
    this.totals.set(userId, total);
  }
  async bagTotal(userId: string): Promise<bigint> {
    return this.totals.get(userId) ?? 0n;
  }
}

export class FakeWishlistPlanSource implements WishlistPlanSourcePort {
  private readonly lists = new Map<string, readonly PlanItem[]>();
  /** Key: `${userId}:${wishlistId ?? "default"}`. */
  set(userId: string, wishlistId: string | null, items: readonly PlanItem[]): void {
    this.lists.set(`${userId}:${wishlistId ?? "default"}`, items);
  }
  async planItems(userId: string, wishlistId: string | null): Promise<readonly PlanItem[] | null> {
    return this.lists.get(`${userId}:${wishlistId ?? "default"}`) ?? null;
  }
}

export class FakeBudgetFlags implements BudgetFlagsPort {
  constructor(
    public suite = true,
    public caps = true,
  ) {}
  async suiteEnabled(): Promise<boolean> {
    return this.suite;
  }
  async capsEnabled(): Promise<boolean> {
    return this.caps;
  }
}
