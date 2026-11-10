import type { Queryable } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { money, negate } from "@outlet/money";
import type { Currency, Money } from "@outlet/money";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { z } from "zod";
import { parseAccountCode } from "../domain/account-code.js";
import { ACCOUNT_TYPES } from "../domain/chart.js";
import { LedgerError } from "../domain/errors.js";
import { validateDraft } from "../domain/draft.js";
import type { JournalEntryDraft, ValidatedDraft } from "../domain/draft.js";
import { GENESIS_HASH, chainHash, contentHash } from "./hash.js";
import type { EntryContent } from "./hash.js";

const outbox = new OutboxWriter(pgTransactionalWriter);

export interface PostResult {
  readonly entryId: string;
  /** True when the idempotency key already existed with identical content; nothing was inserted. */
  readonly replayed: boolean;
}

const iso = (d: Date): string => d.toISOString();

/** Serialises writers per market so the hash chain has a single head. Released at commit/rollback. */
const lockMarket = async (tx: Queryable, marketId: string): Promise<void> => {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`ledger:${marketId}`]);
};

const contentOf = (v: ValidatedDraft): EntryContent => ({
  kind: v.kind,
  idempotencyKey: v.idempotencyKey,
  marketId: v.marketId,
  refType: v.ref.type,
  refId: v.ref.id,
  reversesEntryId: v.reversesEntryId ?? null,
  postings: v.postings.map((p) => ({ accountCode: p.account.code, amountMinor: p.amount.amountMinor, currency: p.amount.currency })),
});

async function resolveAccounts(tx: Queryable, v: ValidatedDraft): Promise<Map<string, string>> {
  const codes = [...new Set(v.postings.map((p) => p.account.code))];
  const found = await tx.query<{ id: string; code: string }>("SELECT id, code FROM ledger_accounts WHERE code = ANY($1::text[])", [codes]);
  const ids = new Map(found.rows.map((r) => [r.code, r.id]));
  for (const p of v.postings) {
    const { account } = p;
    if (ids.has(account.code)) continue;
    const spec = ACCOUNT_TYPES[account.type];
    if (!spec.lazy) {
      throw new LedgerError("LEDGER_ACCOUNT_NOT_FOUND", `platform account ${account.code} does not exist; add it by migration`);
    }
    const id = uuidv7();
    await tx.query(
      `INSERT INTO ledger_accounts (id, code, type, market_id, currency, owner_type, owner_id, sub)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (code) DO NOTHING`,
      [id, account.code, account.type, account.market, account.currency, spec.owner, account.owner ?? "", account.sub ?? ""],
    );
    const row = await tx.query<{ id: string }>("SELECT id FROM ledger_accounts WHERE code = $1", [account.code]);
    const got = row.rows[0];
    if (!got) throw new LedgerError("LEDGER_ACCOUNT_NOT_FOUND", `could not create account ${account.code}`);
    ids.set(account.code, got.id);
  }
  return ids;
}

async function postValidated(tx: Queryable, v: ValidatedDraft, extra: { reason?: string } = {}): Promise<PostResult> {
  await lockMarket(tx, v.marketId);
  const content = contentHash(contentOf(v));

  const existing = await tx.query<{ id: string; content_hash: string }>(
    "SELECT id, content_hash FROM journal_entries WHERE idempotency_key = $1",
    [v.idempotencyKey],
  );
  const prior = existing.rows[0];
  if (prior) {
    if (prior.content_hash !== content) {
      throw new LedgerError("LEDGER_IDEMPOTENCY_CONFLICT", `idempotency key ${v.idempotencyKey} was used with different content`);
    }
    return { entryId: prior.id, replayed: true };
  }

  const accountIds = await resolveAccounts(tx, v);
  const head = await tx.query<{ chain_seq: string; hash: string }>(
    "SELECT chain_seq::text AS chain_seq, hash FROM journal_entries WHERE market_id = $1 ORDER BY journal_entries.chain_seq DESC LIMIT 1",
    [v.marketId],
  );
  const headRow = head.rows[0];
  const chainSeq = headRow ? BigInt(headRow.chain_seq) + 1n : 1n;
  const prevHash = headRow?.hash ?? GENESIS_HASH;
  const id = uuidv7();
  const occurredAt = iso(v.occurredAt);
  const hash = chainHash({ id, chainSeq, contentHash: content, occurredAt, prevHash });

  await tx.query(
    `INSERT INTO journal_entries
       (id, kind, idempotency_key, market_id, occurred_at, ref_type, ref_id, reverses_entry_id, chain_seq, content_hash, prev_hash, hash, note)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9::bigint, $10, $11, $12, $13)`,
    [id, v.kind, v.idempotencyKey, v.marketId, occurredAt, v.ref.type, v.ref.id, v.reversesEntryId ?? null, chainSeq.toString(), content, prevHash, hash, extra.reason ?? null],
  );
  let lineNo = 0;
  for (const p of v.postings) {
    lineNo += 1;
    const accountId = accountIds.get(p.account.code);
    if (accountId === undefined) throw new LedgerError("LEDGER_ACCOUNT_NOT_FOUND", `account ${p.account.code} unresolved`);
    await tx.query(
      `INSERT INTO postings (id, entry_id, line_no, account_id, amount_minor, currency, market_id)
       VALUES ($1, $2, $3, $4, $5::bigint, $6, $7)`,
      [uuidv7(), id, lineNo, accountId, p.amount.amountMinor.toString(), p.amount.currency, v.marketId],
    );
  }
  await outbox.append(tx, {
    id: uuidv7(),
    type: "journal_entry.posted",
    aggregateType: "journal_entry",
    aggregateId: id,
    marketId: v.marketId,
    occurredAt,
    visibility: "internal",
    payload: { entryId: id, kind: v.kind, marketId: v.marketId, ...(extra.reason !== undefined ? { reason: extra.reason } : {}) },
  });
  return { entryId: id, replayed: false };
}

/**
 * Posts one balanced entry in the caller's transaction. Idempotent by idempotencyKey: same content returns the
 * stored entry, different content throws LEDGER_IDEMPOTENCY_CONFLICT. The deferred DB trigger re-checks the sum at COMMIT.
 */
export async function post(tx: Queryable, draft: JournalEntryDraft): Promise<PostResult> {
  return postValidated(tx, validateDraft(draft));
}

export interface ReverseOptions {
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly occurredAt?: Date;
}

interface PostingRow {
  code: string;
  amount: string;
  currency: Currency;
}

/** Creates the reversing entry (negated postings, kind `reversal`, ref to the original). At most one per entry. */
export async function reverse(tx: Queryable, entryId: string, opts: ReverseOptions): Promise<PostResult> {
  if (opts.reason.trim().length === 0 || opts.reason.length > 500) {
    throw new LedgerError("LEDGER_INVALID_DRAFT", "reason must be 1 to 500 characters");
  }
  const orig = await tx.query<{ id: string; kind: string; market_id: string }>(
    "SELECT id, kind, market_id FROM journal_entries WHERE id = $1::uuid",
    [z.uuid().parse(entryId)],
  );
  const original = orig.rows[0];
  if (!original) throw new LedgerError("LEDGER_ENTRY_NOT_FOUND", `journal entry ${entryId} not found`);
  await lockMarket(tx, original.market_id);
  if (original.kind === "reversal") {
    throw new LedgerError("LEDGER_CANNOT_REVERSE_REVERSAL", "a reversal cannot be reversed; post a new entry instead");
  }
  const prior = await tx.query<{ id: string; idempotency_key: string }>(
    "SELECT id, idempotency_key FROM journal_entries WHERE reverses_entry_id = $1::uuid",
    [entryId],
  );
  const reversal = prior.rows[0];
  if (reversal && reversal.idempotency_key !== opts.idempotencyKey) {
    throw new LedgerError("LEDGER_ALREADY_REVERSED", `entry ${entryId} is already reversed by ${reversal.id}`);
  }
  const rows = await tx.query<PostingRow>(
    `SELECT a.code, p.amount_minor::text AS amount, p.currency
       FROM postings p JOIN ledger_accounts a ON a.id = p.account_id
      WHERE p.entry_id = $1::uuid ORDER BY p.line_no`,
    [entryId],
  );
  const draft: JournalEntryDraft = {
    kind: "reversal",
    idempotencyKey: opts.idempotencyKey,
    marketId: original.market_id,
    occurredAt: opts.occurredAt ?? new Date(),
    ref: { type: "journal_entry", id: entryId },
    reversesEntryId: entryId,
    postings: rows.rows.map((r) => ({ accountCode: r.code, amount: negate(money(BigInt(r.amount), r.currency)) })),
  };
  return postValidated(tx, validateDraft(draft), { reason: opts.reason });
}

/** Signed balance (debit positive, credit negative) of an account, optionally as of a business time. Unknown account = 0. */
export async function balance(tx: Queryable, accountCode: string, asOf?: Date): Promise<Money> {
  const parts = parseAccountCode(accountCode);
  const r = await tx.query<{ total: string }>(
    `SELECT COALESCE(SUM(p.amount_minor), 0)::text AS total
       FROM postings p
       JOIN ledger_accounts a ON a.id = p.account_id
       JOIN journal_entries e ON e.id = p.entry_id
      WHERE a.code = $1 AND ($2::timestamptz IS NULL OR e.occurred_at <= $2::timestamptz)`,
    [parts.code, asOf ? iso(asOf) : null],
  );
  return money(BigInt(r.rows[0]?.total ?? "0"), parts.currency);
}

/** Sum of every posting in a market and currency. Must be 0 (I6). */
export async function trialBalance(tx: Queryable, marketId: string, currency: Currency): Promise<Money> {
  const r = await tx.query<{ total: string }>(
    "SELECT COALESCE(SUM(amount_minor), 0)::text AS total FROM postings WHERE market_id = $1 AND currency = $2",
    [marketId, currency],
  );
  return money(BigInt(r.rows[0]?.total ?? "0"), currency);
}

export type ChainVerification =
  | { readonly ok: true; readonly entries: number; readonly headHash: string }
  | { readonly ok: false; readonly entryId: string; readonly chainSeq: bigint; readonly reason: string };

interface ChainRow {
  id: string;
  kind: string;
  idempotency_key: string;
  ref_type: string;
  ref_id: string;
  reverses_entry_id: string | null;
  chain_seq: string;
  content_hash: string;
  prev_hash: string;
  hash: string;
  occurred_iso: string;
  line_no: number | null;
  code: string | null;
  amount: string | null;
  currency: string | null;
}

/** Default entries per verification page (one short transaction each; memory and statement time stay bounded). */
export const CHAIN_PAGE_SIZE = 10_000;

/** Position in a market's hash chain: the last verified entry's `chain_seq` and `hash` (genesis = 0 and GENESIS_HASH). */
export interface ChainCursor {
  readonly seq: bigint;
  readonly hash: string;
}
export const GENESIS_CURSOR: ChainCursor = { seq: 0n, hash: GENESIS_HASH };

export type ChainPageResult =
  /** `cursor` is the last entry of the page; `done` = the page was short, so the chain head was reached. */
  | { readonly ok: true; readonly entries: number; readonly cursor: ChainCursor; readonly done: boolean }
  /** `cursor` stays at the last good entry before the break, so the next run re-verifies (and re-reports) the same link. */
  | { readonly ok: false; readonly entryId: string; readonly chainSeq: bigint; readonly reason: string; readonly cursor: ChainCursor };

/**
 * Verifies up to `limit` entries after `from` (keyset on chain_seq, unique per market): contiguous seq, prev_hash links to the cursor, content hash and entry
 * hash recomputed from the stored rows (I20). One bounded statement, so a caller can run each page in its own short transaction and resume from `cursor`.
 */
export async function verifyChainPage(tx: Queryable, marketId: string, from: ChainCursor, limit: number = CHAIN_PAGE_SIZE): Promise<ChainPageResult> {
  const r = await tx.query<ChainRow>(
    `SELECT e.id, e.kind, e.idempotency_key, e.ref_type, e.ref_id, e.reverses_entry_id,
            e.chain_seq::text AS chain_seq, e.content_hash, e.prev_hash, e.hash,
            to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_iso,
            p.line_no, a.code, p.amount_minor::text AS amount, p.currency
       FROM (SELECT * FROM journal_entries WHERE market_id = $1 AND chain_seq > $2::bigint ORDER BY chain_seq LIMIT $3) e
       LEFT JOIN postings p ON p.entry_id = e.id
       LEFT JOIN ledger_accounts a ON a.id = p.account_id
      ORDER BY e.chain_seq, p.line_no`,
    [marketId, from.seq.toString(), limit],
  );
  const grouped = new Map<string, { head: ChainRow; postings: EntryContent["postings"][number][] }>();
  for (const row of r.rows) {
    const g = grouped.get(row.id) ?? { head: row, postings: [] };
    if (row.code !== null && row.amount !== null && row.currency !== null) {
      g.postings.push({ accountCode: row.code, amountMinor: BigInt(row.amount), currency: row.currency });
    }
    grouped.set(row.id, g);
  }
  let prev = from.hash;
  let seq = from.seq;
  for (const { head, postings } of grouped.values()) {
    seq += 1n;
    const chainSeq = BigInt(head.chain_seq);
    const broken = (reason: string): ChainPageResult => ({ ok: false, entryId: head.id, chainSeq, reason, cursor: { seq: seq - 1n, hash: prev } });
    if (chainSeq !== seq) return broken("chain_seq is not contiguous");
    if (head.prev_hash !== prev) return broken("prev_hash does not match the previous entry");
    const recomputed = contentHash({
      kind: head.kind,
      idempotencyKey: head.idempotency_key,
      marketId,
      refType: head.ref_type,
      refId: head.ref_id,
      reversesEntryId: head.reverses_entry_id,
      postings,
    });
    if (recomputed !== head.content_hash) return broken("content hash does not match the stored rows");
    const expected = chainHash({ id: head.id, chainSeq, contentHash: head.content_hash, occurredAt: head.occurred_iso, prevHash: head.prev_hash });
    if (expected !== head.hash) return broken("entry hash does not match");
    prev = head.hash;
  }
  return { ok: true, entries: grouped.size, cursor: { seq, hash: prev }, done: grouped.size < limit };
}

/** Recomputes the whole chain for a market from stored rows (I20), page by page inside the caller's transaction. Returns the first broken entry. */
export async function verifyChain(tx: Queryable, marketId: string, pageSize: number = CHAIN_PAGE_SIZE): Promise<ChainVerification> {
  let cursor = GENESIS_CURSOR;
  for (;;) {
    const page = await verifyChainPage(tx, marketId, cursor, pageSize);
    if (!page.ok) return { ok: false, entryId: page.entryId, chainSeq: page.chainSeq, reason: page.reason };
    cursor = page.cursor;
    if (page.done) return { ok: true, entries: Number(cursor.seq), headHash: cursor.hash };
  }
}

export const MAX_PAGE_SIZE = 50;

/** Exported so the EXPLAIN test inspects the exact statement that runs. */
export const LIST_ENTRIES_SQL = `SELECT e.id, e.kind, e.idempotency_key, e.market_id, e.ref_type, e.ref_id, e.reverses_entry_id,
       e.chain_seq::text AS chain_seq, e.hash,
       to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_iso
  FROM journal_entries e
 WHERE e.market_id = $1
   AND ($2::timestamptz IS NULL OR (e.occurred_at, e.id) > ($2::timestamptz, $3::uuid))
 ORDER BY e.occurred_at, e.id
 LIMIT $4`;

export interface ListedPosting {
  readonly lineNo: number;
  readonly accountCode: string;
  readonly amount: Money;
}
export interface ListedEntry {
  readonly id: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly marketId: string;
  readonly occurredAt: string;
  readonly refType: string;
  readonly refId: string;
  readonly reversesEntryId: string | null;
  readonly chainSeq: bigint;
  readonly hash: string;
  readonly postings: readonly ListedPosting[];
}
export interface EntryPage {
  readonly entries: readonly ListedEntry[];
  /** Opaque; pass back as `cursor`. Null on the last page. */
  readonly nextCursor: string | null;
}

const cursorSchema = z.strictObject({ o: z.iso.datetime(), i: z.uuid() });

const encodeCursor = (occurredAt: string, id: string): string => Buffer.from(JSON.stringify({ o: occurredAt, i: id })).toString("base64url");
function decodeCursor(cursor: string): { o: string; i: string } {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new LedgerError("LEDGER_INVALID_CURSOR", "cursor is not valid");
  }
}

interface ListRow {
  id: string;
  kind: string;
  idempotency_key: string;
  market_id: string;
  ref_type: string;
  ref_id: string;
  reverses_entry_id: string | null;
  chain_seq: string;
  hash: string;
  occurred_iso: string;
}

/** Keyset page ordered by (occurred_at, id). limit 1..50 (default 50). */
export async function listEntries(
  tx: Queryable,
  args: { readonly marketId: string; readonly cursor?: string; readonly limit?: number },
): Promise<EntryPage> {
  const limit = args.limit ?? MAX_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new LedgerError("LEDGER_INVALID_LIMIT", `limit must be an integer from 1 to ${String(MAX_PAGE_SIZE)}`);
  }
  const cur = args.cursor === undefined ? undefined : decodeCursor(args.cursor);
  const rows = await tx.query<ListRow>(LIST_ENTRIES_SQL, [args.marketId, cur?.o ?? null, cur?.i ?? null, limit + 1]);
  const page = rows.rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.rows.length > limit && last ? encodeCursor(last.occurred_iso, last.id) : null;
  const byEntry = new Map<string, ListedPosting[]>();
  if (page.length > 0) {
    const ps = await tx.query<{ entry_id: string; line_no: number; code: string; amount: string; currency: Currency }>(
      `SELECT p.entry_id, p.line_no, a.code, p.amount_minor::text AS amount, p.currency
         FROM postings p JOIN ledger_accounts a ON a.id = p.account_id
        WHERE p.entry_id = ANY($1::uuid[]) ORDER BY p.entry_id, p.line_no`,
      [page.map((e) => e.id)],
    );
    for (const p of ps.rows) {
      const list = byEntry.get(p.entry_id) ?? [];
      list.push({ lineNo: p.line_no, accountCode: p.code, amount: money(BigInt(p.amount), p.currency) });
      byEntry.set(p.entry_id, list);
    }
  }
  return {
    entries: page.map((e) => ({
      id: e.id,
      kind: e.kind,
      idempotencyKey: e.idempotency_key,
      marketId: e.market_id,
      occurredAt: e.occurred_iso,
      refType: e.ref_type,
      refId: e.ref_id,
      reversesEntryId: e.reverses_entry_id,
      chainSeq: BigInt(e.chain_seq),
      hash: e.hash,
      postings: byEntry.get(e.id) ?? [],
    })),
    nextCursor,
  };
}

/** Namespace-style facade matching the spec's `Ledger.post(tx, draft)` wording. */
export const Ledger = { post, reverse, balance, trialBalance, verifyChain, listEntries } as const;
