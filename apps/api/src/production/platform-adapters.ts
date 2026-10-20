import { createHash } from "node:crypto";
import type {
  ClaimRequest,
  ClaimResult,
  IdempotencyRecord,
  IdempotencyScope,
  IdempotencyStore,
  StoredResponse,
} from "@outlet/idempotency";
import { assertAuditDiff } from "@outlet/privacy";
import type { AuditRecord } from "@outlet/policy";
import { sql, type Kysely } from "kysely";
import type { ExportAuditEntry } from "../modules/seller-analytics";
import type { AuditSink, Clock, ReadinessCheck } from "../platform/ports";

type Db = Kysely<Record<string, never>>;

const sha = (label: string, v: string): Buffer => createHash("sha256").update(`${label}\u0000${v}`).digest();

/** Deterministic uuid from a string (the table keys are uuid; scope parts are opaque strings). */
export function uuidFrom(label: string, value: string): string {
  const h = sha(label, value).subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const ROUTE = "-"; // the real route lives in the row's meta: the port keys records by (actor, key) only

interface Meta {
  readonly route: string;
  readonly requestHash: string;
  readonly claim?: string;
  readonly response?: StoredResponse;
}

interface Row {
  readonly response_status: number | null;
  readonly response_body: Meta;
  readonly locked_until: Date | null;
  readonly created_at: Date;
  readonly expires_at: Date;
}

/**
 * Postgres idempotency store over `idempotency_keys` (migration 0004, no schema change). `claim` is
 * one atomic INSERT ... ON CONFLICT DO UPDATE that only takes over an expired or lease-expired row.
 * The port's string actor/key map to uuid columns through SHA-256; the claim token, route and
 * request hash live in the jsonb meta while the row is in flight.
 */
export class KyselyIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Db) {}

  async claim(req: ClaimRequest): Promise<ClaimResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const out = await this.claimTx(req);
      if (out !== "retry") return out;
    }
    throw new Error("idempotency claim did not settle");
  }

  private async claimTx(req: ClaimRequest): Promise<ClaimResult | "retry"> {
    const actor = uuidFrom("actor", req.scope.actor);
    const key = uuidFrom("key", req.scope.key);
    const meta: Meta = { route: req.route, requestHash: req.requestHash, claim: req.claimToken };
    return this.system(async (trx) => {
      const won = await sql<{ key: string }>`
        INSERT INTO idempotency_keys (actor_id, route, key, request_hash, response_status, response_body, locked_until, created_at, expires_at)
        VALUES (${actor}::uuid, ${ROUTE}, ${key}::uuid, ${sha("hash", req.requestHash)}, NULL, ${JSON.stringify(meta)}::jsonb,
                ${iso(req.nowMs + req.leaseMs)}::timestamptz, ${iso(req.nowMs)}::timestamptz, ${iso(req.nowMs + req.ttlMs)}::timestamptz)
        ON CONFLICT (actor_id, route, key) DO UPDATE SET
          request_hash = EXCLUDED.request_hash, response_status = NULL, response_body = EXCLUDED.response_body,
          locked_until = EXCLUDED.locked_until, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at
        WHERE idempotency_keys.expires_at <= ${iso(req.nowMs)}::timestamptz
           OR (idempotency_keys.response_status IS NULL AND idempotency_keys.locked_until <= ${iso(req.nowMs)}::timestamptz)
        RETURNING key`.execute(trx);
      if (won.rows.length > 0) return { kind: "acquired" } as const;
      const cur = await sql<Row>`
        SELECT response_status, response_body, locked_until, created_at, expires_at FROM idempotency_keys
        WHERE actor_id = ${actor}::uuid AND route = ${ROUTE} AND key = ${key}::uuid`.execute(trx);
      const row = cur.rows[0];
      // Deleted between the two statements (a release): the caller retries as a new claim.
      if (row === undefined) return "retry" as const;
      return { kind: "existing", record: toRecord(req.scope, row) } as const;
    });
  }

  async complete(scope: IdempotencyScope, claimToken: string, response: StoredResponse, nowMs: number): Promise<boolean> {
    const actor = uuidFrom("actor", scope.actor);
    const key = uuidFrom("key", scope.key);
    return this.system(async (trx) => {
      const r = await sql`
        UPDATE idempotency_keys SET response_status = ${response.status},
          response_body = (response_body - 'claim') || ${JSON.stringify({ response })}::jsonb, locked_until = NULL
        WHERE actor_id = ${actor}::uuid AND route = ${ROUTE} AND key = ${key}::uuid
          AND response_status IS NULL AND response_body->>'claim' = ${claimToken}
          AND expires_at > ${iso(nowMs)}::timestamptz
        RETURNING key`.execute(trx);
      return r.rows.length > 0;
    });
  }

  async release(scope: IdempotencyScope, claimToken: string): Promise<boolean> {
    const actor = uuidFrom("actor", scope.actor);
    const key = uuidFrom("key", scope.key);
    return this.system(async (trx) => {
      const r = await sql`
        DELETE FROM idempotency_keys
        WHERE actor_id = ${actor}::uuid AND route = ${ROUTE} AND key = ${key}::uuid
          AND response_status IS NULL AND response_body->>'claim' = ${claimToken}
        RETURNING key`.execute(trx);
      return r.rows.length > 0;
    });
  }

  private system<T>(fn: (trx: Parameters<Parameters<ReturnType<Db["transaction"]>["execute"]>[0]>[0]) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.role', 'system', true)`.execute(trx);
      return fn(trx);
    });
  }
}

function toRecord(scope: IdempotencyScope, row: Row): IdempotencyRecord {
  const m = row.response_body;
  const base = {
    scope,
    route: m.route,
    requestHash: m.requestHash,
    createdAtMs: row.created_at.getTime(),
    expiresAtMs: row.expires_at.getTime(),
  };
  if (row.response_status !== null && m.response !== undefined) {
    return { state: "completed", ...base, response: m.response };
  }
  return {
    state: "in_flight",
    ...base,
    claimToken: m.claim ?? "",
    leaseExpiresAtMs: row.locked_until?.getTime() ?? row.expires_at.getTime(),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const yyyymm = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

/**
 * Authorization decisions into the hash-chained `audit_log` (migration 0005; the trigger assigns
 * seq and hashes). One chain per month, `authz:YYYY-MM`. The diff holds decision metadata only.
 */
export class KyselyAuditSink implements AuditSink {
  constructor(private readonly db: Db) {}

  async record(e: AuditRecord): Promise<void> {
    const targetId = e.resourceId !== null && UUID.test(e.resourceId) ? e.resourceId : null;
    const actorId = e.actorId !== null && UUID.test(e.actorId) ? e.actorId : null;
    const diff = assertAuditDiff({ effect: e.effect, ruleId: e.ruleId, reason: e.reason, httpStatus: e.httpStatus, approverIds: e.approverIds });
    await this.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.role', 'system', true)`.execute(trx);
      await sql`
        INSERT INTO audit_log (occurred_at, chain_id, actor_type, actor_id, action, target_type, target_id, diff_redacted)
        VALUES (${iso(e.atMs)}::timestamptz, ${`authz:${yyyymm(e.atMs)}`}, ${actorId === null ? "system" : "user"},
                ${actorId}::uuid, ${e.action}, ${e.resourceType}, ${targetId}::uuid, ${JSON.stringify(diff)}::jsonb)`.execute(trx);
    });
  }
}

/** Seller analytics export audit into the hash-chained audit_log, chain `seller-analytics:YYYY-MM`. */
export class KyselyExportAudit {
  constructor(private readonly db: Db) {}

  async record(e: ExportAuditEntry): Promise<void> {
    const actorId = UUID.test(e.actorId) ? e.actorId : null;
    const storeId = UUID.test(e.storeId) ? e.storeId : null;
    const diff = assertAuditDiff({ report: e.report, rowCount: e.rowCount, watermark: e.watermark, fromMs: e.fromMs, toMs: e.toMs });
    await this.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.role', 'system', true)`.execute(trx);
      await sql`
        INSERT INTO audit_log (occurred_at, chain_id, actor_type, actor_id, action, target_type, target_id, diff_redacted)
        VALUES (${iso(e.atMs)}::timestamptz, ${`seller-analytics:${yyyymm(e.atMs)}`}, ${actorId === null ? "system" : "user"},
                ${actorId}::uuid, ${e.action}, 'store', ${storeId}::uuid, ${JSON.stringify(diff)}::jsonb)`.execute(trx);
    });
  }
}

export interface OutboxLag {
  readonly state: "ok" | "lagging" | "unknown";
  readonly pending: number;
  readonly oldestAgeSeconds: number;
  readonly deadLettered: number;
}

/** Above this age an unpublished outbox event means the relay is not draining (worker down or stuck). */
export const OUTBOX_LAG_SECONDS = 300;

export async function readOutboxLag(db: Db, clock: Clock): Promise<OutboxLag> {
  try {
    const r = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.role', 'system', true)`.execute(trx);
      return sql<{ pending: string; oldest: Date | null; dead: string }>`
        SELECT count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL) AS pending,
               min(occurred_at) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL) AS oldest,
               count(*) FILTER (WHERE dead_lettered_at IS NOT NULL) AS dead
        FROM outbox_events`.execute(trx);
    });
    const row = r.rows[0];
    const pending = Number(row?.pending ?? 0);
    const age = row?.oldest ? Math.max(0, Math.floor((clock.nowMs() - row.oldest.getTime()) / 1000)) : 0;
    const dead = Number(row?.dead ?? 0);
    return { state: age > OUTBOX_LAG_SECONDS || dead > 0 ? "lagging" : "ok", pending, oldestAgeSeconds: age, deadLettered: dead };
  } catch {
    return { state: "unknown", pending: 0, oldestAgeSeconds: 0, deadLettered: 0 };
  }
}

export class DatabaseReadiness implements ReadinessCheck {
  readonly name = "database";
  constructor(private readonly db: Db) {}
  async check(): Promise<boolean> {
    await sql`SELECT 1`.execute(this.db);
    return true;
  }
}
