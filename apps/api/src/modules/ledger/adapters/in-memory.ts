import {
  GENESIS_HASH,
  describeAccount,
  derivedBalance,
  money,
  type AccountId,
  type ChainLink,
  type JournalEntry,
} from "../domain/bridge";
import type {
  BalanceQuery,
  BalanceRow,
  ChainRow,
  IntegritySnapshots,
  IntegritySource,
  LedgerEvent,
  LedgerReadModel,
  LedgerStore,
  LedgerTxn,
  ProjectionSource,
  ReadScope,
  StoredEntry,
} from "../domain/ports";

/** One FIFO mutex: models the advisory lock that serialises chain appends in Postgres. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  acquire(): Promise<() => void> {
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = this.tail.then(() => release);
    this.tail = this.tail.then(() => next);
    return ready;
  }
}

export class InMemoryLedgerTx implements LedgerTxn {
  readonly staged: StoredEntry[] = [];
  readonly events: LedgerEvent[] = [];
  releases: (() => void)[] = [];
  /** Extra state a test wants rolled back together with the postings (the caller's "state change"). */
  readonly onCommit: (() => void)[] = [];
  async emit(event: LedgerEvent): Promise<unknown> {
    this.events.push(event);
    return event;
  }
}

/**
 * In-memory ledger. `run` is the unit of work: staged entries and events become visible only when
 * the callback resolves, and are discarded when it throws (same contract as the Kysely runner).
 */
export class InMemoryLedger implements LedgerStore<InMemoryLedgerTx>, IntegritySnapshots, IntegritySource, LedgerReadModel {
  readonly entries: StoredEntry[] = [];
  readonly events: LedgerEvent[] = [];
  private seq = 0n;
  private readonly chainLock = new Mutex();
  /** Test hook: entries visible to integrity checks and reads can be tampered with. */
  readonly closedAccounts = new Set<AccountId>();

  async run<R>(fn: (tx: InMemoryLedgerTx) => Promise<R>): Promise<R> {
    const tx = new InMemoryLedgerTx();
    try {
      const out = await fn(tx);
      this.entries.push(...tx.staged);
      this.events.push(...tx.events);
      for (const c of tx.onCommit) c();
      return out;
    } finally {
      for (const r of tx.releases) r();
    }
  }

  // ---- LedgerStore --------------------------------------------------------------------------
  async privileged<R>(_tx: InMemoryLedgerTx, fn: () => Promise<R>): Promise<R> {
    return fn();
  }

  async findByKey(tx: InMemoryLedgerTx, key: string): Promise<StoredEntry | null> {
    return [...this.entries, ...tx.staged].find((s) => s.entry.idempotencyKey === key) ?? null;
  }

  async findById(tx: InMemoryLedgerTx, id: string): Promise<StoredEntry | null> {
    return [...this.entries, ...tx.staged].find((s) => s.entry.id === id) ?? null;
  }

  async lockChain(tx: InMemoryLedgerTx): Promise<void> {
    if (tx.releases.length > 0) return;
    tx.releases.push(await this.chainLock.acquire());
  }

  async chainHead(tx: InMemoryLedgerTx): Promise<string> {
    const all = [...this.entries, ...tx.staged];
    return all[all.length - 1]?.link.entryHash ?? GENESIS_HASH;
  }

  async append(tx: InMemoryLedgerTx, entry: JournalEntry, link: { prevHash: string; entryHash: string }): Promise<StoredEntry> {
    for (const p of entry.postings) {
      if (this.closedAccounts.has(p.account)) throw new Error(`account ${p.account} is closed`);
    }
    this.seq += 1n;
    const stored: StoredEntry = {
      entry: { ...entry, postings: entry.postings.map((p) => ({ ...p })) },
      link: { seq: this.seq, entryId: entry.id, ...link },
    };
    tx.staged.push(stored);
    return stored;
  }

  async reversalOf(tx: InMemoryLedgerTx, entryId: string): Promise<StoredEntry | null> {
    return (
      [...this.entries, ...tx.staged].find((s) => s.entry.kind === "reversal" && s.entry.ref.id === entryId) ?? null
    );
  }

  // ---- LedgerReadModel ----------------------------------------------------------------------
  async balances(_scope: ReadScope, query: BalanceQuery): Promise<readonly BalanceRow[]> {
    const raw = new Map<AccountId, { raw: bigint; n: number }>();
    for (const s of this.entries) {
      for (const p of s.entry.postings) {
        const cur = raw.get(p.account) ?? { raw: 0n, n: 0 };
        raw.set(p.account, { raw: cur.raw + p.amount.amount, n: cur.n + 1 });
      }
    }
    const rows: BalanceRow[] = [];
    for (const [account, v] of raw) {
      const { definition, parameters } = describeAccount(account);
      const ownerId = definition.type === "store_credit" ? (parameters[0] ?? "") : (parameters[0] ?? "");
      const ownerType = ownerTypeOf(definition.owner);
      const subKey = definition.type === "store_credit" ? (parameters[1] ?? "") : "";
      const natural = derivedBalance(account, [
        {
          id: "x",
          kind: "x",
          idempotencyKey: "x",
          occurredAt: new Date(0),
          ref: { type: "x", id: "x" },
          postings: [{ account, amount: money(v.raw) }],
        },
      ]).amount;
      rows.push({
        account,
        type: definition.type,
        ownerType,
        ownerId,
        subKey,
        currency: "EGP",
        raw: v.raw,
        natural,
        postingCount: v.n,
      });
    }
    return rows
      .filter(
        (r) =>
          (query.type === undefined || r.type === query.type) &&
          (query.ownerType === undefined || r.ownerType === query.ownerType) &&
          (query.ownerId === undefined || r.ownerId === query.ownerId),
      )
      .sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0))
      .slice(0, query.limit);
  }

  async entry(_scope: ReadScope, id: string): Promise<StoredEntry | null> {
    return this.entries.find((s) => s.entry.id === id) ?? null;
  }

  // ---- IntegritySource / snapshots ----------------------------------------------------------
  async withSnapshot<R>(fn: (source: IntegritySource) => Promise<R>): Promise<R> {
    return fn(this);
  }

  async trialBalance(): Promise<ReadonlyMap<string, bigint>> {
    const totals = new Map<string, bigint>();
    for (const s of this.entries) {
      for (const p of s.entry.postings) {
        totals.set(p.amount.currency, (totals.get(p.amount.currency) ?? 0n) + p.amount.amount);
      }
    }
    return totals;
  }

  async chainPage(afterSeq: bigint | null, limit: number): Promise<readonly ChainRow[]> {
    return this.entries
      .filter((s) => afterSeq === null || s.link.seq > afterSeq)
      .sort((a, b) => (a.link.seq < b.link.seq ? -1 : 1))
      .slice(0, limit)
      .map((s) => ({ entry: s.entry, link: s.link }));
  }

  async storeCreditBalances(): Promise<readonly { account: AccountId; currency: string; raw: bigint }[]> {
    const raw = new Map<AccountId, bigint>();
    for (const s of this.entries) {
      for (const p of s.entry.postings) {
        if (p.account.startsWith("store_credit:")) raw.set(p.account, (raw.get(p.account) ?? 0n) + p.amount.amount);
      }
    }
    return [...raw].map(([account, v]) => ({ account, currency: "EGP", raw: v }));
  }

  /** Test hook: replaces a stored entry's postings to simulate tampering. */
  tamper(entryId: string, mutate: (e: JournalEntry) => JournalEntry): void {
    const i = this.entries.findIndex((s) => s.entry.id === entryId);
    const cur = this.entries[i];
    if (cur !== undefined) this.entries[i] = { entry: mutate(cur.entry), link: cur.link as ChainLink };
  }
}

function ownerTypeOf(owner: string): string {
  return owner === "seller" ? "store" : owner === "shopper" ? "user" : owner;
}

export class InMemoryProjection implements ProjectionSource {
  constructor(public readonly data: { userId: string; sub: string; balance: bigint }[] = []) {}
  async rows() {
    return this.data;
  }
}
