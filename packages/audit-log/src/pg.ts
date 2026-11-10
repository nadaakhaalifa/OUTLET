import type { Queryable, SqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { z } from "zod";
import { AuditEntryInputSchema, GENESIS_HASH, buildEntry, verifyChain } from "./chain.js";
import type { AuditEntry, AuditEntryInput } from "./chain.js";

/**
 * Postgres audit persistence (migration 0028). Hand it a client already bound to an outlet_app context
 * (contextClient / withDbContext): outlet_app can only INSERT into audit_log; head, list and verify
 * reads go through the SECURITY DEFINER functions, which pin app.current_market_id().
 */

export interface StoredAuditEntry extends AuditEntry {
  readonly seq: number;
}

export const AuditFiltersSchema = z.object({
  actorId: z.string().min(1).optional(),
  targetType: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
});
export type AuditFilters = z.infer<typeof AuditFiltersSchema>;

export interface AuditPage {
  readonly items: readonly StoredAuditEntry[];
  /** Pass back as `cursor` for the next (older) page; undefined on the last page. */
  readonly nextCursor: number | undefined;
}

export type ChainVerification =
  | { readonly ok: true; readonly checked: number; readonly headSeq: number | undefined }
  | { readonly ok: false; readonly brokenSeq: number; readonly reason: "hash" | "link" | "gap" | "market" };

export const MAX_PAGE = 200;
const VERIFY_BATCH = 500;

interface Row {
  id: string;
  market_id: string;
  seq: number | string | bigint;
  actor_type: AuditEntry["actorType"];
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  diff: AuditEntry["diff"];
  ip_hash: string | null;
  device_id: string | null;
  request_id: string | null;
  occurred_at: Date | string;
  prev_hash: string;
  hash: string;
}

const toEntry = (r: Row): StoredAuditEntry => ({
  seq: Number(r.seq),
  id: r.id,
  marketId: r.market_id,
  actorType: r.actor_type,
  actorId: r.actor_id,
  action: r.action,
  targetType: r.target_type,
  targetId: r.target_id,
  diff: r.diff,
  ipHash: r.ip_hash,
  deviceId: r.device_id,
  requestId: r.request_id,
  occurredAt: new Date(r.occurred_at).toISOString(),
  prevHash: r.prev_hash,
  hash: r.hash,
});

export interface PgAuditStoreOptions {
  readonly now?: () => Date;
  readonly newId?: (nowMs: number) => string;
}

export class PgAuditStore {
  private readonly now: () => Date;
  private readonly newId: (nowMs: number) => string;

  constructor(private readonly db: SqlClient, options: PgAuditStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? uuidv7;
  }

  /** Appends in its own transaction. Prefer appendIn so the entry commits with the audited change. */
  append(input: AuditEntryInput): Promise<StoredAuditEntry> {
    return this.db.transaction((tx) => this.appendIn(tx, input));
  }

  /**
   * Appends inside the caller's transaction. A per-market advisory lock serialises writers, so the chain
   * is gapless (seq = head + 1, prev_hash = head hash) and a rollback leaves no hole.
   */
  async appendIn(tx: Queryable, raw: AuditEntryInput): Promise<StoredAuditEntry> {
    const input = AuditEntryInputSchema.parse(raw);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`audit_log:${input.marketId}`]);
    const head = (await tx.query<{ seq: number | string | bigint; hash: string }>("SELECT seq, hash FROM audit_log_head()")).rows[0];
    const at = this.now();
    const entry = buildEntry(input, head?.hash ?? GENESIS_HASH, at, this.newId(at.getTime()));
    const seq = head === undefined ? 1 : Number(head.seq) + 1;
    await tx.query(
      `INSERT INTO audit_log (id, market_id, seq, actor_type, actor_id, action, target_type, target_id, diff, ip_hash, device_id, request_id, occurred_at, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15)`,
      [
        entry.id, entry.marketId, seq, entry.actorType, entry.actorId, entry.action, entry.targetType, entry.targetId,
        entry.diff === null ? null : JSON.stringify(entry.diff), entry.ipHash, entry.deviceId, entry.requestId,
        entry.occurredAt, entry.prevHash, entry.hash,
      ],
    );
    return { ...entry, seq };
  }

  /** Newest first. `cursor` is the seq of the last row already seen. */
  async list(filters: AuditFilters = {}, cursor?: number, limit = 50): Promise<AuditPage> {
    const f = AuditFiltersSchema.parse(filters);
    const take = Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE);
    const rows = await this.page(cursor ?? null, take + 1, true, f);
    const items = rows.slice(0, take);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > take && last !== undefined ? last.seq : undefined };
  }

  /**
   * Re-computes every hash and link of `marketId` from `fromSeq` (default: genesis) in batches.
   * Detects edits, reordering and mid-chain deletion. A truncated tail needs an external seal (audit_seals).
   */
  async verifyChain(marketId: string, fromSeq?: number): Promise<ChainVerification> {
    let prev = GENESIS_HASH;
    let expectSeq = 1;
    let cursor: number | null = null;
    if (fromSeq !== undefined && fromSeq > 1) {
      const anchor = (await this.page(fromSeq - 2 < 1 ? null : fromSeq - 2, 1, false, {}))[0];
      if (anchor?.seq !== fromSeq - 1) return { ok: false, brokenSeq: fromSeq, reason: "gap" };
      prev = anchor.hash;
      expectSeq = fromSeq;
      cursor = fromSeq - 1;
    }
    let checked = 0;
    let headSeq: number | undefined;
    for (;;) {
      const batch = await this.page(cursor, VERIFY_BATCH, false, {});
      if (batch.length === 0) return { ok: true, checked, headSeq };
      for (const e of batch) {
        if (e.marketId !== marketId) return { ok: false, brokenSeq: e.seq, reason: "market" };
        if (e.seq !== expectSeq) return { ok: false, brokenSeq: e.seq, reason: "gap" };
        if (e.prevHash !== prev) return { ok: false, brokenSeq: e.seq, reason: "link" };
        const entry: AuditEntry = { ...e }; // spread copies seq too; strip it (storage-only, not hashed)
        delete (entry as { seq?: number }).seq;
        if (!verifyChain([entry], prev).ok) return { ok: false, brokenSeq: e.seq, reason: "hash" };
        prev = e.hash;
        expectSeq += 1;
        headSeq = e.seq;
        checked += 1;
      }
      cursor = headSeq ?? null;
    }
  }

  private async page(cursor: number | null, limit: number, desc: boolean, f: AuditFilters): Promise<StoredAuditEntry[]> {
    const r = await this.db.query<Row>("SELECT * FROM audit_log_page($1, $2, $3, $4, $5, $6, $7)", [
      cursor, limit, desc, f.actorId ?? null, f.targetType ?? null, f.targetId ?? null, f.action ?? null,
    ]);
    return r.rows.map(toEntry);
  }
}

export const PiiAccessInputSchema = z.object({
  marketId: z.string().min(1),
  actorId: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  action: z.string().min(1),
  /** Required: every staff PII view carries a reason code (master prompt 23). */
  reasonCode: z.string().min(1).max(64),
  requestId: z.string().min(1).nullable().default(null),
});
export type PiiAccessInput = z.input<typeof PiiAccessInputSchema>;

export interface PiiAccessRecord {
  readonly id: string;
  readonly marketId: string;
  readonly actorId: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly action: string;
  readonly reasonCode: string;
  readonly requestId: string | null;
  readonly occurredAt: string;
}

interface PiiRow {
  id: string;
  market_id: string;
  actor_id: string;
  target_type: string;
  target_id: string;
  action: string;
  reason_code: string;
  request_id: string | null;
  occurred_at: Date | string;
}

export interface PiiPage {
  readonly items: readonly PiiAccessRecord[];
  /** Opaque keyset cursor for the next (older) page. */
  readonly nextCursor: string | undefined;
}

export class PiiAccessLog {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly db: SqlClient, options: { readonly now?: () => Date; readonly newId?: () => string } = {}) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? uuidv7;
  }

  record(input: PiiAccessInput): Promise<PiiAccessRecord> {
    return this.recordIn(this.db, input);
  }

  /** Writes inside the caller's transaction so a read and its access record commit together. */
  async recordIn(tx: Queryable, raw: PiiAccessInput): Promise<PiiAccessRecord> {
    const i = PiiAccessInputSchema.parse(raw);
    const rec: PiiAccessRecord = { id: this.newId(), ...i, occurredAt: this.now().toISOString() };
    await tx.query(
      `INSERT INTO pii_access_log (id, market_id, actor_id, target_type, target_id, action, reason_code, request_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [rec.id, rec.marketId, rec.actorId, rec.targetType, rec.targetId, rec.action, rec.reasonCode, rec.requestId, rec.occurredAt],
    );
    return rec;
  }

  async list(filters: Pick<AuditFilters, "actorId" | "targetType" | "targetId"> = {}, cursor?: string, limit = 50): Promise<PiiPage> {
    const take = Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE);
    let at: string | null = null;
    let id: string | null = null;
    if (cursor !== undefined) {
      const parts = z.tuple([z.iso.datetime(), z.uuid()]).safeParse(cursor.split("|"));
      if (!parts.success) throw new TypeError("invalid pii access cursor");
      [at, id] = parts.data;
    }
    const r = await this.db.query<PiiRow>("SELECT * FROM pii_access_log_page($1, $2, $3, $4, $5, $6)", [
      at, id, take + 1, filters.actorId ?? null, filters.targetType ?? null, filters.targetId ?? null,
    ]);
    const all = r.rows.map(
      (x): PiiAccessRecord => ({
        id: x.id, marketId: x.market_id, actorId: x.actor_id, targetType: x.target_type, targetId: x.target_id, action: x.action,
        reasonCode: x.reason_code, requestId: x.request_id, occurredAt: new Date(x.occurred_at).toISOString(),
      }),
    );
    const items = all.slice(0, take);
    const last = items[items.length - 1];
    return { items, nextCursor: all.length > take && last !== undefined ? `${last.occurredAt}|${last.id}` : undefined };
  }
}
