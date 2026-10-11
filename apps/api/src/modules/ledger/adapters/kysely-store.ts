import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { toPersistedOwnerType, type DomainAccountOwner } from "@outlet/db";
import { applySession, asSystemRole, resolveTxOptions, type DbTx } from "../../../platform/db";
import {
  GENESIS_HASH,
  describeAccount,
  type AccountId,
  type JournalEntry,
  type Posting,
} from "../domain/bridge";
import { money } from "../domain/bridge";
import type {
  BalanceQuery,
  BalanceRow,
  ChainRow,
  IntegritySnapshots,
  IntegritySource,
  LedgerReadModel,
  LedgerStore,
  LedgerTxn,
  ReadScope,
  StoredEntry,
} from "../domain/ports";
import { IdempotencyKeyTaken } from "../domain/ports";

/** Raw SQL with Zod-validated rows, like the orders and tax adapters. */
export type LedgerDb = Kysely<Record<string, never>>;

/** What the store needs from the caller's transaction: the typed transaction and the outbox emit. */
export interface LedgerDbTx extends LedgerTxn {
  readonly db: Transaction<Record<string, never>> | Transaction<never> | Transaction<unknown>;
}

/** Adapts the platform unit-of-work handle so the posting joins the caller's transaction. */
export function ledgerTxOf(tx: DbTx): LedgerDbTx {
  return {
    db: tx.db as unknown as Transaction<unknown>,
    emit: (event) => tx.emit({ ...event, payload: { ...event.payload } }),
  };
}

/** Arbitrary constant: the advisory lock key that serialises ledger chain appends. */
const CHAIN_LOCK_KEY = 7_274_010_031;

const Int = z.string().regex(/^-?\d+$/);
const Big = Int.transform((s) => BigInt(s));
const Hash = z.string().regex(/^[0-9a-f]{64}$/);

const EntryRow = z.object({
  id: z.string(),
  kind: z.string(),
  idempotency_key: z.string(),
  occurred_ms: Big,
  ref_type: z.string(),
  ref_id: z.string(),
  seq: Big,
  prev_hash: Hash,
  entry_hash: Hash,
});
const PostingRow = z.object({
  entry_id: z.string(),
  type: z.string(),
  owner_id: z.string(),
  sub_key: z.string(),
  amount: Big,
  currency: z.string(),
});

const ENTRY_COLS = sql.raw(`
  e.id::text as id, e.kind, e.idempotency_key,
  floor(extract(epoch from e.occurred_at) * 1000)::text as occurred_ms,
  e.ref_type, e.ref_id, c.seq::text as seq, c.prev_hash, c.entry_hash`);

/** `type:owner[:sub]` as the domain spells it. */
export function accountIdOf(type: string, ownerId: string, subKey: string): AccountId {
  const parts = [type];
  if (ownerId !== "") parts.push(ownerId);
  if (subKey !== "") parts.push(subKey);
  return parts.join(":");
}

interface AccountIdentity {
  readonly type: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly subKey: string;
}

export function identityOf(account: AccountId): AccountIdentity {
  const { definition, parameters } = describeAccount(account);
  const owner = definition.owner as DomainAccountOwner;
  const ownerType = toPersistedOwnerType(owner);
  if (definition.parameters.length === 0) return { type: definition.type, ownerType, ownerId: "", subKey: "" };
  const [ownerId = "", subKey = ""] = parameters;
  return { type: definition.type, ownerType, ownerId, subKey };
}

const isUnique = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";

/**
 * Postgres adapter for the posting service. Every method runs on the CALLER's transaction handle
 * (`tx.db`), so postings commit with the caller's state change and outbox rows. Writes need the
 * `system` role (RLS); `privileged` raises it for the duration of one posting and restores it.
 */
export class KyselyLedgerStore<T extends LedgerDbTx> implements LedgerStore<T> {
  private static trx(tx: LedgerDbTx): Transaction<Record<string, never>> {
    return tx.db as Transaction<Record<string, never>>;
  }

  privileged<R>(tx: T, fn: () => Promise<R>): Promise<R> {
    return asSystemRole(KyselyLedgerStore.trx(tx), fn);
  }

  async findByKey(tx: T, key: string): Promise<StoredEntry | null> {
    return this.load(tx, sql`e.idempotency_key = ${key}`);
  }

  async findById(tx: T, id: string): Promise<StoredEntry | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return this.load(tx, sql`e.id = ${id}::uuid`);
  }

  async reversalOf(tx: T, entryId: string): Promise<StoredEntry | null> {
    return this.load(tx, sql`e.reverses_entry_id = ${entryId}::uuid`);
  }

  async lockChain(tx: T): Promise<void> {
    await sql`select pg_advisory_xact_lock(${CHAIN_LOCK_KEY})`.execute(KyselyLedgerStore.trx(tx));
  }

  async chainHead(tx: T): Promise<string> {
    const r = await sql<{ h: string }>`select entry_hash as h from ledger_entry_chain order by seq desc limit 1`.execute(
      KyselyLedgerStore.trx(tx),
    );
    return r.rows[0]?.h ?? GENESIS_HASH;
  }

  async append(tx: T, entry: JournalEntry, link: { prevHash: string; entryHash: string }): Promise<StoredEntry> {
    const trx = KyselyLedgerStore.trx(tx);
    const ids = new Map<AccountId, string>();
    for (const p of entry.postings) {
      if (ids.has(p.account)) continue;
      ids.set(p.account, await this.accountId(trx, p.account, p.amount.currency));
    }
    const reverses = entry.kind === "reversal" && entry.ref.type === "journal_entry" ? entry.ref.id : null;
    try {
      await sql`
        insert into journal_entries (id, kind, idempotency_key, occurred_at, ref_type, ref_id, reverses_entry_id)
        values (${entry.id}::uuid, ${entry.kind}, ${entry.idempotencyKey}, ${entry.occurredAt.toISOString()}::timestamptz,
                ${entry.ref.type}, ${entry.ref.id}, ${reverses}::uuid)`.execute(trx);
    } catch (e) {
      if (isUnique(e)) throw new IdempotencyKeyTaken(entry.idempotencyKey);
      throw e;
    }
    const rows = entry.postings.map(
      (p) =>
        sql`(${entry.id}::uuid, ${ids.get(p.account) ?? ""}::uuid, ${p.amount.amount.toString()}::bigint, ${p.amount.currency})`,
    );
    await sql`insert into postings (entry_id, account_id, amount, currency) values ${sql.join(rows)}`.execute(trx);
    const chained = await sql<{ seq: string }>`
      insert into ledger_entry_chain (entry_id, prev_hash, entry_hash)
      values (${entry.id}::uuid, ${link.prevHash}, ${link.entryHash}) returning seq::text as seq`.execute(trx);
    const seq = BigInt(chained.rows[0]?.seq ?? "0");
    return {
      entry: { ...entry, postings: entry.postings.map((p) => ({ ...p })) },
      link: { seq, entryId: entry.id, prevHash: link.prevHash, entryHash: link.entryHash },
    };
  }

  private async accountId(trx: Transaction<Record<string, never>>, account: AccountId, currency: string): Promise<string> {
    const a = identityOf(account);
    await sql`
      insert into ledger_accounts (type, owner_type, owner_id, sub_key, currency)
      values (${a.type}, ${a.ownerType}, ${a.ownerId}, ${a.subKey}, ${currency})
      on conflict (type, owner_type, owner_id, sub_key, currency) do nothing`.execute(trx);
    const r = await sql<{ id: string; closed: boolean }>`
      select id::text as id, closed_at is not null as closed from ledger_accounts
      where type = ${a.type} and owner_type = ${a.ownerType} and owner_id = ${a.ownerId}
        and sub_key = ${a.subKey} and currency = ${currency}`.execute(trx);
    const row = r.rows[0];
    if (row === undefined) throw new Error(`ledger account ${account} could not be resolved`);
    if (row.closed) throw new Error(`ledger account ${account} is closed`);
    return row.id;
  }

  private async load(tx: T, where: ReturnType<typeof sql>): Promise<StoredEntry | null> {
    return loadEntry(KyselyLedgerStore.trx(tx), where);
  }
}

export async function loadEntry(
  trx: Transaction<Record<string, never>> | LedgerDb,
  where: ReturnType<typeof sql>,
): Promise<StoredEntry | null> {
  const r = await sql<unknown>`
    select ${ENTRY_COLS} from journal_entries e join ledger_entry_chain c on c.entry_id = e.id where ${where}`.execute(trx);
  const row = r.rows[0];
  if (row === undefined) return null;
  const e = EntryRow.parse(row);
  const postings = await loadPostings(trx, [e.id]);
  return toStored(e, postings.get(e.id) ?? []);
}

async function loadPostings(
  trx: Transaction<Record<string, never>> | LedgerDb,
  ids: readonly string[],
): Promise<Map<string, Posting[]>> {
  const out = new Map<string, Posting[]>();
  if (ids.length === 0) return out;
  const r = await sql<unknown>`
    select p.entry_id::text as entry_id, a.type, a.owner_id, a.sub_key, p.amount::text as amount, p.currency
    from postings p join ledger_accounts a on a.id = p.account_id
    where p.entry_id in (${sql.join(ids.map((i) => sql`${i}::uuid`))})
    order by p.id`.execute(trx);
  for (const raw of r.rows) {
    const p = PostingRow.parse(raw);
    const list = out.get(p.entry_id) ?? [];
    list.push({ account: accountIdOf(p.type, p.owner_id, p.sub_key), amount: money(p.amount) });
    out.set(p.entry_id, list);
  }
  return out;
}

function toStored(e: z.output<typeof EntryRow>, postings: Posting[]): StoredEntry {
  return {
    entry: {
      id: e.id,
      kind: e.kind,
      idempotencyKey: e.idempotency_key,
      occurredAt: new Date(Number(e.occurred_ms)),
      ref: { type: e.ref_type, id: e.ref_id },
      postings,
    },
    link: { seq: e.seq, entryId: e.id, prevHash: e.prev_hash, entryHash: e.entry_hash },
  };
}

const ROLE = /^[a-z_][a-z0-9_]*$/;

/**
 * Finance and admin reads. Own read transaction as `app_user` with the caller's role, so RLS
 * (finance, super_admin, system only) is the second line of defence behind the controller's gate.
 */
export class KyselyLedgerReadModel implements LedgerReadModel {
  constructor(
    private readonly db: LedgerDb,
    private readonly applicationRole: string | null = "app_user",
  ) {}

  private async read<R>(scope: ReadScope, fn: (trx: Transaction<Record<string, never>>) => Promise<R>): Promise<R> {
    if (this.applicationRole !== null && !ROLE.test(this.applicationRole)) throw new RangeError("invalid role name");
    return this.db.transaction().execute(async (trx) => {
      await applySession(
        trx,
        resolveTxOptions({ session: { userId: scope.actorId, role: scope.role }, process: "ledger.read", profile: "read" }),
        this.applicationRole,
      );
      return fn(trx);
    });
  }

  async balances(scope: ReadScope, query: BalanceQuery): Promise<readonly BalanceRow[]> {
    return this.read(scope, async (trx) => {
      const conds = [sql`true`];
      if (query.type !== undefined) conds.push(sql`a.type = ${query.type}`);
      if (query.ownerType !== undefined) conds.push(sql`a.owner_type = ${query.ownerType}`);
      if (query.ownerId !== undefined) conds.push(sql`a.owner_id = ${query.ownerId}`);
      const r = await sql<unknown>`
        select a.type, a.owner_type, a.owner_id, a.sub_key, a.currency,
               coalesce(sum(p.amount), 0)::text as raw, count(p.id)::text as n
        from ledger_accounts a left join postings p on p.account_id = a.id and p.currency = a.currency
        where ${sql.join(conds, sql` and `)}
        group by a.id order by a.type, a.owner_id, a.sub_key, a.currency
        limit ${query.limit}`.execute(trx);
      const Row = z.object({
        type: z.string(),
        owner_type: z.string(),
        owner_id: z.string(),
        sub_key: z.string(),
        currency: z.string(),
        raw: Big,
        n: z.string(),
      });
      return r.rows.map((x): BalanceRow => {
        const row = Row.parse(x);
        const account = accountIdOf(row.type, row.owner_id, row.sub_key);
        const debitNormal = describeAccount(account).definition.normalBalance === "debit";
        return {
          account,
          type: row.type,
          ownerType: row.owner_type,
          ownerId: row.owner_id,
          subKey: row.sub_key,
          currency: row.currency,
          raw: row.raw,
          natural: debitNormal ? row.raw : -row.raw,
          postingCount: Number(row.n),
        };
      });
    });
  }

  async entry(scope: ReadScope, id: string): Promise<StoredEntry | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    return this.read(scope, (trx) => loadEntry(trx, sql`e.id = ${id}::uuid`));
  }
}

/** Integrity reads in ONE REPEATABLE READ transaction as `system`, so totals and chain agree. */
export class KyselyIntegritySnapshots implements IntegritySnapshots {
  constructor(
    private readonly db: LedgerDb,
    private readonly applicationRole: string | null = "app_user",
  ) {}

  async withSnapshot<R>(fn: (source: IntegritySource) => Promise<R>): Promise<R> {
    return this.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (trx) => {
        await applySession(
          trx,
          resolveTxOptions({ session: { userId: null, role: "system" }, process: "ledger.integrity", profile: "batch" }),
          this.applicationRole,
        );
        return fn(new TrxIntegritySource(trx));
      });
  }
}

class TrxIntegritySource implements IntegritySource {
  constructor(private readonly trx: Transaction<Record<string, never>>) {}

  async trialBalance(): Promise<ReadonlyMap<string, bigint>> {
    const r = await sql<{ currency: string; total: string }>`
      select currency, sum(amount)::text as total from postings group by currency`.execute(this.trx);
    return new Map(r.rows.map((x) => [x.currency, BigInt(x.total)] as const));
  }

  async chainPage(afterSeq: bigint | null, limit: number): Promise<readonly ChainRow[]> {
    const after = afterSeq === null ? sql`true` : sql`c.seq > ${afterSeq.toString()}::bigint`;
    const r = await sql<unknown>`
      select ${ENTRY_COLS} from ledger_entry_chain c join journal_entries e on e.id = c.entry_id
      where ${after} order by c.seq limit ${limit}`.execute(this.trx);
    const rows = r.rows.map((x) => EntryRow.parse(x));
    const postings = await loadPostings(this.trx, rows.map((x) => x.id));
    return rows.map((row) => {
      const s = toStored(row, postings.get(row.id) ?? []);
      return { entry: s.entry, link: s.link };
    });
  }

  async storeCreditBalances() {
    const r = await sql<{ type: string; owner_id: string; sub_key: string; currency: string; raw: string }>`
      select a.type, a.owner_id, a.sub_key, a.currency, coalesce(sum(p.amount), 0)::text as raw
      from ledger_accounts a left join postings p on p.account_id = a.id and p.currency = a.currency
      where a.type = 'store_credit' group by a.id`.execute(this.trx);
    return r.rows.map((x) => ({
      account: accountIdOf(x.type, x.owner_id, x.sub_key),
      currency: x.currency,
      raw: BigInt(x.raw),
    }));
  }
}
