import { sql, type Kysely, type RawBuilder } from "kysely";
import type { ConsentHistory, ConsentRecord } from "@outlet/privacy";
import { z } from "zod";
import {
  DSAR_SLA_DAYS,
  ERASURE_PARKED_CODE,
  deletionMachine,
  exportMachine,
  type BreachEntry,
  type DeletionRequest,
  type ExportRequest,
  type PrivacyRequest,
} from "../domain/bridge";
import type {
  BreachRepository,
  ConsentRepository,
  InsertOutcome,
  OutboxDraft,
  PrivacyRequestRepository,
  UpdateOutcome,
} from "../domain/ports";

/** Raw SQL with rows validated by Zod, like the other Kysely adapters (ADR-0020). */
export type PrivacyDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Amount = Int.transform((s) => BigInt(s));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));

const epochMs = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);

async function inSystemTx<T>(db: PrivacyDb, run: (trx: PrivacyDb) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.role', 'system', true)`.execute(trx);
    return run(trx as unknown as PrivacyDb);
  });
}

async function appendEvents(trx: PrivacyDb, events: readonly OutboxDraft[]): Promise<void> {
  for (const e of events) {
    await sql`
      insert into outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, ordering_key, payload)
      values (${e.id}::uuid, ${iso(e.occurredAtMs)}::timestamptz, ${e.aggregateType}, ${e.aggregateId}::uuid,
              ${e.type}, ${`${e.aggregateType}:${e.aggregateId}`}, ${JSON.stringify(e.payload)}::jsonb)`.execute(trx);
  }
}

// ------------------------------------------------------------------ consent

const METHOD_TO_DB: Readonly<Record<ConsentRecord["method"], string>> = {
  onboarding_toggle: "onboarding",
  settings_toggle: "settings",
  permission_dialog: "prompt",
  web_banner: "api",
  support_agent_on_request: "api",
};
const METHOD_FROM_DB: Readonly<Record<string, ConsentRecord["method"]>> = {
  onboarding: "onboarding_toggle",
  settings: "settings_toggle",
  prompt: "permission_dialog",
  api: "web_banner",
};

const ConsentRow = z.object({
  purpose: z.enum([
    "marketing_push",
    "marketing_whatsapp",
    "marketing_email",
    "analytics",
    "personalization",
    "budget_insights",
    "measurements",
    "location_precise",
    "cross_border_ml",
  ]),
  version: z.number().int().positive(),
  granted: z.boolean(),
  method: z.string(),
  at: z.string(),
  ip_hash: z.string().nullable(),
});

/**
 * consent_records (0006) is append-only by trigger. subject_type is always 'user' here: device
 * consent captured before registration belongs to the auth module.
 */
export class KyselyConsentRepository implements ConsentRepository {
  constructor(private readonly db: PrivacyDb) {}

  async history(userId: string): Promise<ConsentHistory> {
    if (!UUID.test(userId)) return [];
    return inSystemTx(this.db, async (trx) => {
      const r = await sql`
        select purpose, version, granted, method, ip_hash,
               to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at
        from consent_records
        where subject_type = 'user' and subject_id = ${userId}::uuid
        order by seq`.execute(trx);
      return r.rows.map((raw): ConsentRecord => {
        const row = ConsentRow.parse(raw);
        return {
          userId,
          purpose: row.purpose,
          version: row.version,
          granted: row.granted,
          method: METHOD_FROM_DB[row.method] ?? "settings_toggle",
          at: row.at,
          ipHash: row.ip_hash ?? "0".repeat(16),
        };
      });
    });
  }

  async append(records: readonly ConsentRecord[], events: readonly OutboxDraft[]): Promise<void> {
    if (records.length === 0 && events.length === 0) return;
    await inSystemTx(this.db, async (trx) => {
      for (const r of records) {
        await sql`
          insert into consent_records (subject_type, subject_id, purpose, version, granted, method, occurred_at, ip_hash)
          values ('user', ${r.userId}::uuid, ${r.purpose}, ${r.version}, ${r.granted},
                  ${METHOD_TO_DB[r.method]}, ${r.at}::timestamptz, ${r.ipHash})`.execute(trx);
      }
      await appendEvents(trx, events);
    });
  }
}

// ------------------------------------------------------------------ requests

const Blockers = z.array(z.object({ kind: z.enum(["open_orders", "open_returns", "open_disputes"]), count: z.number().int() }));

const RequestRow = z.object({
  id: z.string(),
  user_id: z.string(),
  kind: z.enum(["export", "delete"]),
  status: z.string(),
  locale: z.enum(["ar", "en"]),
  requested_ms: Ms,
  ready_target_ms: Ms.nullable(),
  cooling_ends_ms: Ms.nullable(),
  forfeited: Amount,
  blockers: Blockers,
  attempts: z.number().int(),
  failure_code: z.string().nullable(),
  completed_ms: Ms.nullable(),
  cancelled_ms: Ms.nullable(),
  export_object_ref: z.string().nullable(),
  artifact_expires_ms: Ms.nullable(),
  version: z.number().int(),
  updated_ms: Ms,
});

const REQUEST_COLS = sql`
  id::text as id, user_id::text as user_id, kind, status, locale,
  ${epochMs("requested_at")} as requested_ms, ${epochMs("ready_target_at")} as ready_target_ms,
  ${epochMs("cooling_ends_at")} as cooling_ends_ms, forfeited_credit_amount::text as forfeited,
  blockers, attempts, failure_code, ${epochMs("completed_at")} as completed_ms,
  ${epochMs("cancelled_at")} as cancelled_ms, export_object_ref,
  ${epochMs("artifact_expires_at")} as artifact_expires_ms, version, ${epochMs("updated_at")} as updated_ms`;

const OPEN_EXPORT_SQL = sql`kind = 'export' and status in ('requested', 'collecting', 'ready')`;
const OPEN_DELETE_SQL = sql`kind = 'delete' and status in ('cooling', 'on_hold', 'erasing')`;

function toRequest(raw: unknown): PrivacyRequest {
  const r = RequestRow.parse(raw);
  if (r.kind === "export") {
    if (r.ready_target_ms === null) throw new Error("export row without ready_target_at");
    const req: ExportRequest = {
      kind: "export",
      id: r.id,
      userId: r.user_id,
      status: exportMachine.parseState(r.status),
      locale: r.locale,
      requestedAtMs: r.requested_ms,
      readyTargetAtMs: r.ready_target_ms,
      attempts: r.attempts,
      failureCode: r.failure_code,
      objectRef: r.export_object_ref,
      completedAtMs: r.completed_ms,
      artifactExpiresAtMs: r.artifact_expires_ms,
      version: r.version,
      updatedAtMs: r.updated_ms,
    };
    return req;
  }
  if (r.cooling_ends_ms === null) throw new Error("deletion row without cooling_ends_at");
  const req: DeletionRequest = {
    kind: "delete",
    id: r.id,
    userId: r.user_id,
    status: deletionMachine.parseState(r.status),
    requestedAtMs: r.requested_ms,
    coolingEndsAtMs: r.cooling_ends_ms,
    forfeitedCreditMinor: r.forfeited,
    blockers: r.blockers,
    attempts: r.attempts,
    failureCode: r.failure_code,
    completedAtMs: r.completed_ms,
    cancelledAtMs: r.cancelled_ms,
    version: r.version,
    updatedAtMs: r.updated_ms,
  };
  return req;
}

export class KyselyPrivacyRequestRepository implements PrivacyRequestRepository {
  constructor(private readonly db: PrivacyDb) {}

  private async insert(r: PrivacyRequest, events: readonly OutboxDraft[]): Promise<InsertOutcome<PrivacyRequest>> {
    return inSystemTx(this.db, async (trx) => {
      const exp = r.kind === "export" ? r : null;
      const del = r.kind === "delete" ? r : null;
      const ins = await sql`
        insert into dsar_requests (id, user_id, kind, status, locale, requested_at, due_at, ready_target_at,
          cooling_ends_at, forfeited_credit_amount, blockers, attempts, failure_code, completed_at, cancelled_at,
          export_object_ref, artifact_expires_at, version, updated_at)
        values (${r.id}::uuid, ${r.userId}::uuid, ${r.kind}, ${r.status}, ${exp?.locale ?? "ar"},
          ${iso(r.requestedAtMs)}::timestamptz, ${iso(r.requestedAtMs + DSAR_SLA_DAYS * DAY_MS)}::timestamptz,
          ${isoOrNull(exp?.readyTargetAtMs ?? null)}::timestamptz, ${isoOrNull(del?.coolingEndsAtMs ?? null)}::timestamptz,
          ${(del?.forfeitedCreditMinor ?? 0n).toString()}::bigint, ${JSON.stringify(del?.blockers ?? [])}::jsonb,
          ${(exp ?? del)?.attempts ?? 0}, ${(exp ?? del)?.failureCode ?? null}, ${isoOrNull(r.completedAtMs)}::timestamptz,
          ${isoOrNull(del?.cancelledAtMs ?? null)}::timestamptz, ${exp?.objectRef ?? null},
          ${isoOrNull(exp?.artifactExpiresAtMs ?? null)}::timestamptz, ${r.version}, ${iso(r.updatedAtMs)}::timestamptz)
        on conflict do nothing
        returning id::text as id`.execute(trx);
      if (ins.rows.length === 1) {
        await appendEvents(trx, events);
        return { kind: "created", request: r };
      }
      const open = r.kind === "export" ? OPEN_EXPORT_SQL : OPEN_DELETE_SQL;
      const existing = await sql`
        select ${REQUEST_COLS} from dsar_requests where user_id = ${r.userId}::uuid and ${open} limit 1`.execute(trx);
      const row = existing.rows[0];
      if (row === undefined) throw new Error(`dsar_requests insert of ${r.id} conflicted without an open request`);
      return { kind: "existing", request: toRequest(row) };
    });
  }

  async insertExport(request: ExportRequest, events: readonly OutboxDraft[]): Promise<InsertOutcome<ExportRequest>> {
    const out = await this.insert(request, events);
    if (out.request.kind !== "export") throw new Error("kind mismatch");
    return { kind: out.kind, request: out.request };
  }

  async insertDeletion(request: DeletionRequest, events: readonly OutboxDraft[]): Promise<InsertOutcome<DeletionRequest>> {
    const out = await this.insert(request, events);
    if (out.request.kind !== "delete") throw new Error("kind mismatch");
    return { kind: out.kind, request: out.request };
  }

  async get(id: string): Promise<PrivacyRequest | null> {
    if (!UUID.test(id)) return null;
    return inSystemTx(this.db, async (trx) => {
      const r = await sql`select ${REQUEST_COLS} from dsar_requests where id = ${id}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toRequest(row);
    });
  }

  findLatest(userId: string, kind: "export"): Promise<ExportRequest | null>;
  findLatest(userId: string, kind: "delete"): Promise<DeletionRequest | null>;
  async findLatest(userId: string, kind: "export" | "delete"): Promise<ExportRequest | DeletionRequest | null> {
    if (!UUID.test(userId)) return null;
    return inSystemTx(this.db, async (trx) => {
      const open = kind === "export" ? OPEN_EXPORT_SQL : OPEN_DELETE_SQL;
      const r = await sql`
        select ${REQUEST_COLS} from dsar_requests
        where user_id = ${userId}::uuid and kind = ${kind}
        order by (case when ${open} then 0 else 1 end), requested_at desc, updated_at desc, id desc
        limit 1`.execute(trx);
      const row = r.rows[0];
      if (row === undefined) return null;
      const req = toRequest(row);
      return req.kind === kind ? req : null;
    });
  }

  async update(next: PrivacyRequest, events: readonly OutboxDraft[]): Promise<UpdateOutcome> {
    return inSystemTx(this.db, async (trx) => {
      const exp = next.kind === "export" ? next : null;
      const del = next.kind === "delete" ? next : null;
      const upd = await sql`
        update dsar_requests set
          status = ${next.status}, blockers = ${JSON.stringify(del?.blockers ?? [])}::jsonb,
          forfeited_credit_amount = ${(del?.forfeitedCreditMinor ?? 0n).toString()}::bigint,
          attempts = ${(exp ?? del)?.attempts ?? 0}, failure_code = ${(exp ?? del)?.failureCode ?? null},
          completed_at = ${isoOrNull(next.completedAtMs)}::timestamptz,
          cancelled_at = ${isoOrNull(del?.cancelledAtMs ?? null)}::timestamptz,
          export_object_ref = ${exp?.objectRef ?? null},
          artifact_expires_at = ${isoOrNull(exp?.artifactExpiresAtMs ?? null)}::timestamptz,
          version = ${next.version}, updated_at = ${iso(next.updatedAtMs)}::timestamptz
        where id = ${next.id}::uuid and user_id = ${next.userId}::uuid and kind = ${next.kind}
          and version = ${next.version - 1}
        returning id::text as id`.execute(trx);
      if (upd.rows.length === 1) {
        await appendEvents(trx, events);
        return "ok";
      }
      const exists = await sql`select 1 as x from dsar_requests where id = ${next.id}::uuid`.execute(trx);
      return exists.rows.length === 0 ? "not_found" : "conflict";
    });
  }

  private async list(where: RawBuilder<unknown>, limit: number, order: "asc" | "desc" = "asc") {
    return inSystemTx(this.db, async (trx) => {
      const r = await sql`
        select ${REQUEST_COLS} from dsar_requests where ${where}
        order by requested_at ${sql.raw(order)}, id ${sql.raw(order)} limit ${limit}`.execute(trx);
      return r.rows.map(toRequest);
    });
  }

  async listPendingExports(limit: number): Promise<readonly ExportRequest[]> {
    const rows = await this.list(sql`kind = 'export' and status = 'requested'`, limit);
    return rows.filter((r): r is ExportRequest => r.kind === "export");
  }

  async listExpiredExports(nowMs: number, limit: number): Promise<readonly ExportRequest[]> {
    const rows = await this.list(
      sql`kind = 'export' and status = 'ready' and artifact_expires_at <= ${iso(nowMs)}::timestamptz`,
      limit,
    );
    return rows.filter((r): r is ExportRequest => r.kind === "export");
  }

  async listDueDeletions(nowMs: number, limit: number): Promise<readonly DeletionRequest[]> {
    const rows = await this.list(
      sql`kind = 'delete' and failure_code is distinct from ${ERASURE_PARKED_CODE}
          and (status = 'erasing'
            or (status in ('cooling', 'on_hold') and cooling_ends_at <= ${iso(nowMs)}::timestamptz))`,
      limit,
    );
    return rows.filter((r): r is DeletionRequest => r.kind === "delete");
  }

  async listForQueue(limit: number): Promise<readonly PrivacyRequest[]> {
    // Open filter in SQL BEFORE the limit; oldest requested (= earliest due, same SLA) first.
    return this.list(sql`((${OPEN_EXPORT_SQL}) or (${OPEN_DELETE_SQL}))`, limit, "asc");
  }

  async listRecentClosed(limit: number): Promise<readonly PrivacyRequest[]> {
    return this.list(sql`not ((${OPEN_EXPORT_SQL}) or (${OPEN_DELETE_SQL}))`, limit, "desc");
  }

  async listExportsForUser(userId: string): Promise<readonly ExportRequest[]> {
    if (!UUID.test(userId)) return [];
    const rows = await this.list(sql`kind = 'export' and user_id = ${userId}::uuid`, 1000);
    return rows.filter((r): r is ExportRequest => r.kind === "export");
  }
}

// ------------------------------------------------------------------ breach

const BreachRow = z.object({
  id: z.string(),
  detected_ms: Ms,
  severity: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string(),
  affected_count: z.number().int(),
  status: z.enum(["detected", "triaged", "pdpc_notified", "subjects_notified", "closed"]),
  triaged_ms: Ms.nullable(),
  dpo_decision: z.enum(["notify", "no_notification_required"]).nullable(),
  pdpc_ms: Ms.nullable(),
  subjects_ms: Ms.nullable(),
  closed_ms: Ms.nullable(),
  version: z.number().int(),
  updated_ms: Ms,
});

const BREACH_COLS = sql`
  id::text as id, ${epochMs("detected_at")} as detected_ms, severity, summary, affected_count, status,
  ${epochMs("triaged_at")} as triaged_ms, dpo_decision, ${epochMs("pdpc_notified_at")} as pdpc_ms,
  ${epochMs("subjects_notified_at")} as subjects_ms, ${epochMs("closed_at")} as closed_ms,
  version, ${epochMs("updated_at")} as updated_ms`;

function toBreach(raw: unknown): BreachEntry {
  const r = BreachRow.parse(raw);
  return {
    id: r.id,
    detectedAtMs: r.detected_ms,
    severity: r.severity,
    summary: r.summary,
    affectedCount: r.affected_count,
    status: r.status,
    triagedAtMs: r.triaged_ms,
    dpoDecision: r.dpo_decision,
    pdpcNotifiedAtMs: r.pdpc_ms,
    subjectsNotifiedAtMs: r.subjects_ms,
    closedAtMs: r.closed_ms,
    version: r.version,
    updatedAtMs: r.updated_ms,
  };
}

export class KyselyBreachRepository implements BreachRepository {
  constructor(private readonly db: PrivacyDb) {}

  async insert(e: BreachEntry, events: readonly OutboxDraft[]): Promise<void> {
    await inSystemTx(this.db, async (trx) => {
      await sql`
        insert into breach_register (id, detected_at, severity, summary, affected_count, status, triaged_at,
          dpo_decision, pdpc_notified_at, subjects_notified_at, closed_at, version, created_at, updated_at)
        values (${e.id}::uuid, ${iso(e.detectedAtMs)}::timestamptz, ${e.severity}, ${e.summary}, ${e.affectedCount},
          ${e.status}, ${isoOrNull(e.triagedAtMs)}::timestamptz, ${e.dpoDecision},
          ${isoOrNull(e.pdpcNotifiedAtMs)}::timestamptz, ${isoOrNull(e.subjectsNotifiedAtMs)}::timestamptz,
          ${isoOrNull(e.closedAtMs)}::timestamptz, ${e.version}, ${iso(e.updatedAtMs)}::timestamptz,
          ${iso(e.updatedAtMs)}::timestamptz)`.execute(trx);
      await appendEvents(trx, events);
    });
  }

  async get(id: string): Promise<BreachEntry | null> {
    if (!UUID.test(id)) return null;
    return inSystemTx(this.db, async (trx) => {
      const r = await sql`select ${BREACH_COLS} from breach_register where id = ${id}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toBreach(row);
    });
  }

  async update(next: BreachEntry, events: readonly OutboxDraft[]): Promise<UpdateOutcome> {
    return inSystemTx(this.db, async (trx) => {
      const upd = await sql`
        update breach_register set status = ${next.status}, triaged_at = ${isoOrNull(next.triagedAtMs)}::timestamptz,
          dpo_decision = ${next.dpoDecision}, pdpc_notified_at = ${isoOrNull(next.pdpcNotifiedAtMs)}::timestamptz,
          subjects_notified_at = ${isoOrNull(next.subjectsNotifiedAtMs)}::timestamptz,
          closed_at = ${isoOrNull(next.closedAtMs)}::timestamptz, version = ${next.version},
          updated_at = ${iso(next.updatedAtMs)}::timestamptz
        where id = ${next.id}::uuid and version = ${next.version - 1}
        returning id::text as id`.execute(trx);
      if (upd.rows.length === 1) {
        await appendEvents(trx, events);
        return "ok";
      }
      const exists = await sql`select 1 as x from breach_register where id = ${next.id}::uuid`.execute(trx);
      return exists.rows.length === 0 ? "not_found" : "conflict";
    });
  }

  async list(limit: number): Promise<readonly BreachEntry[]> {
    return inSystemTx(this.db, async (trx) => {
      const r = await sql`
        select ${BREACH_COLS} from breach_register order by detected_at desc, id limit ${limit}`.execute(trx);
      return r.rows.map(toBreach);
    });
  }
}
