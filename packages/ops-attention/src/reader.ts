import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import type { AttentionKind, AttentionRefType, AttentionStatus, ResolutionCode } from "./domain.js";

export interface AttentionItem {
  readonly id: string;
  readonly kind: AttentionKind;
  readonly refType: AttentionRefType;
  readonly refId: string;
  readonly payload: Readonly<Record<string, string>>;
  readonly status: AttentionStatus;
  readonly createdAt: string;
  readonly ackedBy: string | null;
  readonly ackedAt: string | null;
  readonly resolvedAt: string | null;
  readonly resolutionCode: ResolutionCode | null;
}
/** Non-resolved items of the market, for the admin dashboard tile. `byKind` counts OPEN + ACKED together; `oldestAt` is the oldest non-resolved item. */
export interface AttentionCounts { readonly open: number; readonly acked: number; readonly byKind: Readonly<Record<string, number>>; readonly oldestAt: string | null }
/** Runs inside the same outlet_app transaction as the update, only when a row really changed (e.g. the admin module appends its audit entry here). */
export type AttentionChangeHook = (tx: Queryable, item: AttentionItem, before: AttentionStatus) => Promise<void>;
export interface AttentionPage { readonly items: AttentionItem[]; readonly nextCursor: string | null }
export type AttentionActionResult =
  | { readonly outcome: "ok"; readonly item: AttentionItem; readonly changed: boolean }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "conflict"; readonly item: AttentionItem };

interface Row {
  id: string; kind: AttentionKind; ref_type: AttentionRefType; ref_id: string; payload: Record<string, string>; status: AttentionStatus;
  created_at: Date | string; acked_by: string | null; acked_at: Date | string | null; resolved_at: Date | string | null; resolution_code: ResolutionCode | null;
}
const COLS = "id, kind, ref_type, ref_id, payload, status, created_at, acked_by, acked_at, resolved_at, resolution_code";
const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : iso(v));
const toItem = (r: Row): AttentionItem => ({ id: r.id, kind: r.kind, refType: r.ref_type, refId: r.ref_id, payload: r.payload, status: r.status, createdAt: iso(r.created_at), ackedBy: r.acked_by, ackedAt: isoOrNull(r.acked_at), resolvedAt: isoOrNull(r.resolved_at), resolutionCode: r.resolution_code });

const encodeCursor = (r: AttentionItem): string => Buffer.from(`${r.createdAt}|${r.id}`).toString("base64url");
const decodeCursor = (c: string): { at: string; id: string } | null => {
  const [at, id, extra] = Buffer.from(c, "base64url").toString("utf8").split("|");
  if (at === undefined || id === undefined || extra !== undefined || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/.test(id)) return null;
  return { at, id };
};

/**
 * Admin-side reader of the ops attention queue, on outlet_app in the `user` context (migration 0033: SELECT, and UPDATE of the status, ack and resolution
 * columns only). The HTTP layer owns the staff permission check and the audit entry; this class never creates items.
 * Intended routes (wired by the admin module): GET /v1/admin/attention?cursor=&limit= ; POST /v1/admin/attention/{id}/ack ; POST /v1/admin/attention/{id}/resolve {resolutionCode}.
 */
export class PgAttentionReader {
  constructor(private readonly client: RoleSqlClient<"outlet_app">, private readonly marketId: string, private readonly now: () => Date = () => new Date()) {}

  /** Non-resolved items, newest first. An undecodable cursor is treated as no cursor. limit is clamped to 1..100. */
  async listOpen(opts: { readonly limit?: number; readonly cursor?: string } = {}, actorId?: string): Promise<AttentionPage> {
    const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit ?? 50)));
    const cur = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
    const rows = await this.run(actorId, async (tx) =>
      (await tx.query<Row>(
        `SELECT ${COLS} FROM attention_items WHERE market_id = $1 AND status <> 'RESOLVED' AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $4`,
        [this.marketId, cur?.at ?? null, cur?.id ?? null, limit + 1],
      )).rows,
    );
    const items = rows.slice(0, limit).map(toItem);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null };
  }

  /** One grouped statement over the partial index of non-resolved items (the dashboard tile; no per-item data leaves). */
  async countOpen(actorId?: string): Promise<AttentionCounts> {
    const rows = await this.run(actorId, async (tx) =>
      (await tx.query<{ kind: string; status: AttentionStatus; n: number; oldest: Date | string }>(
        "SELECT kind, status, count(*)::int AS n, min(created_at) AS oldest FROM attention_items WHERE market_id = $1 AND status <> 'RESOLVED' GROUP BY kind, status",
        [this.marketId],
      )).rows,
    );
    const byKind: Record<string, number> = {};
    let open = 0;
    let acked = 0;
    let oldest: string | null = null;
    for (const r of rows) {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + r.n;
      if (r.status === "OPEN") open += r.n;
      else acked += r.n;
      const at = iso(r.oldest);
      if (oldest === null || at < oldest) oldest = at;
    }
    return { open, acked, byKind, oldestAt: oldest };
  }

  /** OPEN -> ACKED. Acking an ACKED item is an unchanged success; a RESOLVED item is a conflict. */
  ack(id: string, actorId: string, onChange?: AttentionChangeHook): Promise<AttentionActionResult> {
    return this.act(id, actorId, onChange, "OPEN", async (tx) =>
      (await tx.query<Row>(
        `UPDATE attention_items SET status = 'ACKED', acked_by = $2::uuid, acked_at = $3::timestamptz WHERE id = $1 AND market_id = $4 AND status = 'OPEN' RETURNING ${COLS}`,
        [id, actorId, this.now().toISOString(), this.marketId],
      )).rows[0],
      (cur) => (cur.status === "ACKED" ? "same" : "conflict"),
    );
  }

  /** OPEN | ACKED -> RESOLVED with a fixed code. Resolving again with the same code is an unchanged success; another code is a conflict. */
  resolve(id: string, actorId: string, resolutionCode: ResolutionCode, onChange?: AttentionChangeHook): Promise<AttentionActionResult> {
    const at = this.now().toISOString();
    return this.act(id, actorId, onChange, null, async (tx) =>
      (await tx.query<Row>(
        `UPDATE attention_items SET status = 'RESOLVED', resolved_at = $3::timestamptz, resolution_code = $5,
                acked_by = COALESCE(acked_by, $2::uuid), acked_at = COALESCE(acked_at, $3::timestamptz)
          WHERE id = $1 AND market_id = $4 AND status <> 'RESOLVED' RETURNING ${COLS}`,
        [id, actorId, at, this.marketId, resolutionCode],
      )).rows[0],
      (cur) => (cur.status === "RESOLVED" && cur.resolutionCode === resolutionCode ? "same" : "conflict"),
    );
  }

  private act(id: string, actorId: string, onChange: AttentionChangeHook | undefined, fixedBefore: AttentionStatus | null, update: (tx: Queryable) => Promise<Row | undefined>, onNoRow: (cur: AttentionItem) => "same" | "conflict"): Promise<AttentionActionResult> {
    return this.run(actorId, async (tx) => {
      // Status before the update, for the audit hook (ack always starts from OPEN; resolve from OPEN or ACKED, read first only when a hook wants it).
      const before = onChange === undefined ? null : fixedBefore ?? ((await tx.query<{ status: AttentionStatus }>("SELECT status FROM attention_items WHERE id = $1 AND market_id = $2", [id, this.marketId])).rows[0]?.status ?? null);
      const row = await update(tx);
      if (row !== undefined) {
        const item = toItem(row);
        if (onChange !== undefined && before !== null) await onChange(tx, item, before);
        return { outcome: "ok", item, changed: true } as const;
      }
      const cur = (await tx.query<Row>(`SELECT ${COLS} FROM attention_items WHERE id = $1 AND market_id = $2`, [id, this.marketId])).rows[0];
      if (cur === undefined) return { outcome: "not_found" } as const;
      const item = toItem(cur);
      return onNoRow(item) === "same" ? ({ outcome: "ok", item, changed: false } as const) : ({ outcome: "conflict", item } as const);
    });
  }

  private run<T>(actorId: string | undefined, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.client, { kind: "user", marketId: this.marketId, ...(actorId === undefined ? {} : { userId: actorId }) }, fn);
  }
}
