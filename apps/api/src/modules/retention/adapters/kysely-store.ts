import { sql, type Kysely, type RawBuilder } from "kysely";
import { z } from "zod";
import type { BlobDeletePort, PurgeCount, PurgeExecutor, PurgeRunRecord, PurgeRunStore, PurgeTarget } from "../domain/ports";

export type RetentionDb = Kysely<Record<string, never>>;

const IDENT = /^[a-z_][a-z0-9_]*$/;
const iso = (ms: number): string => new Date(ms).toISOString();
const Num = z.string().regex(/^\d+$/).transform(Number);
const CountRow = z.object({ eligible: Num, held: Num, oldest: z.union([z.date(), z.string()]).nullable() });
const IdRow = z.object({ id: z.string(), ref: z.string().nullable() });
const NRow = z.object({ n: Num });

export class UnsafeTargetError extends Error {
  constructor(readonly targetId: string, what: string) {
    super(`purge target ${targetId}: unsafe ${what}`);
    this.name = "UnsafeTargetError";
  }
}

/** Identifiers come from the constant catalog; this is a belt-and-braces shape check, not input sanitising. */
export function assertSafeTarget(t: PurgeTarget): void {
  for (const [what, v] of [["table", t.table], ...(t.dependents ?? []).flatMap((d) => [["dependent table", d.table], ["dependent fk", d.fk]] as const), ...(t.nullify ?? []).map((c) => ["nullify column", c] as const), ...(t.blobColumn === undefined ? [] : [["blob column", t.blobColumn] as const])] as const) {
    if (!IDENT.test(v)) throw new UnsafeTargetError(t.id, what);
  }
  for (const [what, v] of [["age", t.age], ["where", t.where ?? ""], ["hold", t.holdUser ?? ""]] as const) {
    if (/;|--|\/\*/.test(v)) throw new UnsafeTargetError(t.id, what);
  }
  if ((t.dependents !== undefined || t.blobColumn !== undefined) && t.pk !== "id") throw new UnsafeTargetError(t.id, "pk for dependents or blobs");
  if (t.action === "nullify" && (t.nullify === undefined || t.nullify.length === 0)) throw new UnsafeTargetError(t.id, "nullify columns");
}

/** `FROM table t WHERE age < cutoff AND guard AND NOT held`. Parameters: $1 cutoff. */
function eligibleFrom(t: PurgeTarget, cutoff: string, withHold: "unheld" | "held" | "any"): RawBuilder<unknown> {
  const hold = t.holdUser === undefined ? "false" : `EXISTS (SELECT 1 FROM retention_legal_holds h WHERE h.released_at IS NULL AND h.subject_type = 'user' AND h.subject_id = (${t.holdUser}))`;
  const heldPred = withHold === "any" ? "true" : withHold === "held" ? hold : `NOT (${hold})`;
  return sql`FROM ${sql.raw(t.table)} t WHERE (${sql.raw(t.age)}) < ${cutoff}::timestamptz AND (${sql.raw(t.where ?? "true")}) AND ${sql.raw(heldPred)}`;
}

export class KyselyPurgeExecutor implements PurgeExecutor {
  constructor(
    private readonly db: RetentionDb,
    private readonly blobs?: BlobDeletePort,
    private readonly statementTimeoutMs = 15_000,
  ) {}

  async count(t: PurgeTarget, cutoffMs: number): Promise<PurgeCount> {
    assertSafeTarget(t);
    const cutoff = iso(cutoffMs);
    const base = eligibleFrom(t, cutoff, "any");
    const hold = t.holdUser === undefined ? "false" : `EXISTS (SELECT 1 FROM retention_legal_holds h WHERE h.released_at IS NULL AND h.subject_type = 'user' AND h.subject_id = (${t.holdUser}))`;
    const r = await sql<Record<string, unknown>>`
      SELECT count(*) FILTER (WHERE NOT (${sql.raw(hold)}))::text AS eligible,
             count(*) FILTER (WHERE ${sql.raw(hold)})::text AS held,
             min(${sql.raw(t.age)}) FILTER (WHERE NOT (${sql.raw(hold)})) AS oldest
      ${base}`.execute(this.db);
    const row = CountRow.parse(r.rows[0]);
    return { eligible: row.eligible, held: row.held, oldestEligibleMs: row.oldest === null ? null : new Date(row.oldest).getTime() };
  }

  async purgeBatch(t: PurgeTarget, cutoffMs: number, limit: number): Promise<number> {
    assertSafeTarget(t);
    const cutoff = iso(cutoffMs);
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('statement_timeout', ${String(this.statementTimeoutMs)}, true)`.execute(trx);
      const from = eligibleFrom(t, cutoff, "unheld");
      if (t.pk === "id") return this.byId(trx, t, from, limit);
      return this.byCtid(trx, t, from, limit);
    });
  }

  private async byCtid(trx: RetentionDb, t: PurgeTarget, from: RawBuilder<unknown>, limit: number): Promise<number> {
    const pick = sql`SELECT t.ctid ${from} LIMIT ${limit} FOR UPDATE OF t SKIP LOCKED`;
    const stmt =
      t.action === "delete"
        ? sql`WITH d AS (DELETE FROM ${sql.raw(t.table)} WHERE ctid IN (${pick}) RETURNING 1) SELECT count(*)::text AS n FROM d`
        : sql`WITH d AS (UPDATE ${sql.raw(t.table)} SET ${sql.raw((t.nullify ?? []).map((c) => `${c} = NULL`).join(", "))} WHERE ctid IN (${pick}) RETURNING 1) SELECT count(*)::text AS n FROM d`;
    const r = await stmt.execute(trx);
    return NRow.parse(r.rows[0]).n;
  }

  private async byId(trx: RetentionDb, t: PurgeTarget, from: RawBuilder<unknown>, limit: number): Promise<number> {
    const ref = t.blobColumn === undefined ? "NULL" : `t.${t.blobColumn}::text`;
    const picked = await sql<Record<string, unknown>>`SELECT t.id::text AS id, ${sql.raw(ref)} AS ref ${from} LIMIT ${limit} FOR UPDATE OF t SKIP LOCKED`.execute(trx);
    const rows = picked.rows.map((r) => IdRow.parse(r));
    if (rows.length === 0) return 0;
    const ids = rows.map((r) => r.id);
    // The object-store delete is idempotent and runs first: a crash leaves rows whose blobs are already gone, never the reverse.
    const refs = rows.flatMap((r) => (r.ref === null ? [] : [r.ref]));
    if (refs.length > 0) {
      if (this.blobs === undefined) throw new Error("blob delete port missing");
      await this.blobs.deleteMany(refs);
    }
    for (const d of t.dependents ?? []) {
      await sql`DELETE FROM ${sql.raw(d.table)} WHERE ${sql.raw(d.fk)} = ANY(${ids}::uuid[])`.execute(trx);
    }
    if (t.action === "delete") await sql`DELETE FROM ${sql.raw(t.table)} WHERE id = ANY(${ids}::uuid[])`.execute(trx);
    else await sql`UPDATE ${sql.raw(t.table)} SET ${sql.raw((t.nullify ?? []).map((c) => `${c} = NULL`).join(", "))} WHERE id = ANY(${ids}::uuid[])`.execute(trx);
    return rows.length;
  }
}

const RunRow = z.object({
  id: z.string(), rule_id: z.string(), target_id: z.string(), dry_run: z.boolean(),
  cutoff_at: z.union([z.date(), z.string()]), started_at: z.union([z.date(), z.string()]), finished_at: z.union([z.date(), z.string()]).nullable(),
  status: z.enum(["RUNNING", "COMPLETED", "PARTIAL", "FAILED"]), rows_purged: Num, rows_eligible: Num.nullable(), rows_held: Num, batches: z.number(),
  oldest_eligible_at: z.union([z.date(), z.string()]).nullable(), error_code: z.string().nullable(),
});
const ms = (v: Date | string): number => new Date(v).getTime();

export class KyselyPurgeRunStore implements PurgeRunStore {
  constructor(private readonly db: RetentionDb) {}
  async start(r: Pick<PurgeRunRecord, "id" | "ruleId" | "targetId" | "dryRun" | "cutoffMs" | "startedMs">): Promise<void> {
    await sql`INSERT INTO retention_purge_runs (id, rule_id, target_id, dry_run, cutoff_at, started_at, status)
      VALUES (${r.id}::uuid, ${r.ruleId}, ${r.targetId}, ${r.dryRun}, ${iso(r.cutoffMs)}::timestamptz, ${iso(r.startedMs)}::timestamptz, 'RUNNING')`.execute(this.db);
  }
  async finish(id: string, f: Parameters<PurgeRunStore["finish"]>[1]): Promise<void> {
    await sql`UPDATE retention_purge_runs SET finished_at = ${iso(f.finishedMs ?? Date.now())}::timestamptz, status = ${f.status}, rows_purged = ${f.rowsPurged},
      rows_eligible = ${f.rowsEligible}, rows_held = ${f.rowsHeld}, batches = ${f.batches},
      oldest_eligible_at = ${f.oldestEligibleMs === null ? null : iso(f.oldestEligibleMs)}::timestamptz, error_code = ${f.errorCode}
      WHERE id = ${id}::uuid`.execute(this.db);
  }
  async list(ruleId?: string): Promise<readonly PurgeRunRecord[]> {
    const r = await sql<Record<string, unknown>>`SELECT id::text, rule_id, target_id, dry_run, cutoff_at, started_at, finished_at, status, rows_purged::text, rows_eligible::text,
      rows_held::text, batches, oldest_eligible_at, error_code FROM retention_purge_runs
      WHERE (${ruleId ?? null}::text IS NULL OR rule_id = ${ruleId ?? null}) ORDER BY started_at, id`.execute(this.db);
    return r.rows.map((x) => {
      const p = RunRow.parse(x);
      return { id: p.id, ruleId: p.rule_id, targetId: p.target_id, dryRun: p.dry_run, cutoffMs: ms(p.cutoff_at), startedMs: ms(p.started_at), finishedMs: p.finished_at === null ? null : ms(p.finished_at), status: p.status, rowsPurged: p.rows_purged, rowsEligible: p.rows_eligible, rowsHeld: p.rows_held, batches: p.batches, oldestEligibleMs: p.oldest_eligible_at === null ? null : ms(p.oldest_eligible_at), errorCode: p.error_code };
    });
  }
}

/** Fail-closed stand-in until an object-store adapter exists: evidence rows stay, so no blob is ever orphaned. */
export class UnconfiguredBlobDelete implements BlobDeletePort {
  async deleteMany(): Promise<void> {
    throw new Error("object store adapter not configured for retention");
  }
}
