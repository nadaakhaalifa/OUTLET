import { createHash } from "node:crypto";
import type { AuditEntryInput } from "@outlet/audit-log";
import { PgAuditStore } from "@outlet/audit-log";
import { contextClient, withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient, SqlClient } from "@outlet/db";
import { FlagService, KILL_SWITCHES, PostgresFlagStore, isKillSwitchName } from "@outlet/flags";
import type { FlagRecord, KillSwitchName } from "@outlet/flags";
import type { Principal } from "@outlet/policy";
import { decodeCursor, encodeCursor } from "../../platform/cursor.js";
import { Problems } from "../../platform/problem.js";
import type { AuditLogEntryPage, AuditQuery, AuditVerifyQuery, AuditVerifyResult, ElevationDto, ElevationPage, ElevationsQuery, FeatureFlagDto, FeatureFlagPage, FlagsQuery } from "./dto-ops.js";

/** Appends one hash-chained audit entry. AuditChain satisfies it; production stays Unconfigured (503) until the Postgres chain is composed. */
export interface AuditAppendPort {
  /** Written in the caller's transaction: the entry commits or rolls back with the audited change. */
  appendIn(tx: Queryable, input: AuditEntryInput): Promise<unknown>;
}

export interface FlagAdminPort {
  /** Rows of this market plus the global rows, as stored. */
  list(marketId: string): Promise<readonly FlagRecord[]>;
  /** enabled=false engages the kill switch for the staff's market, true releases it. Audited with the reason. */
  /** `tx`: join the caller's transaction (an approval being executed) instead of opening one. */
  set(p: Principal, name: KillSwitchName, enabled: boolean, reason: string, tx?: Queryable): Promise<FlagRecord>;
}

export interface AuditReaderPort {
  list(p: Principal, q: AuditQuery): Promise<AuditLogEntryPage>;
  /** Re-hashes the market's chain (read-only; a broken chain is a result, not an error). */
  verify(p: Principal, q: AuditVerifyQuery): Promise<AuditVerifyResult>;
}

export interface ElevationReaderPort {
  /** `all`: every elevation of the market (approvers); otherwise only the caller's own. */
  list(p: Principal, q: ElevationsQuery, all: boolean): Promise<ElevationPage>;
  /** 404 when it is not in the market, or is someone else's and `all` is false. */
  get(p: Principal, id: string, all: boolean): Promise<ElevationDto>;
}

/** The Admin Console operations on flags and the audit trail. Optional on AdminServices: absent means 503 (not composed). */
export interface AdminOpsServices {
  readonly flags: FlagAdminPort;
  readonly audit: AuditReaderPort;
  /** Absent until composed: the elevation routes answer 503. */
  readonly elevations?: ElevationReaderPort;
}

const noopAudit = { record: (): Promise<void> => Promise.resolve() };

/** A transaction as a SqlClient whose `transaction` joins it, so PostgresFlagStore.put runs inside the caller's transaction. */
const joined = (tx: Queryable): SqlClient => ({
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
  query: <Row extends object>(sql: string, params?: readonly unknown[]) => tx.query<Row>(sql, params),
  transaction: <T>(fn: (t: Queryable) => Promise<T>) => fn(tx),
});

/** Per-market kill-switch writes: the flag flip and its audit entry (the staff reason is kept as a SHA-256 hash, never as free text) are ONE transaction, so neither exists without the other. */
export class FlagAdmin implements FlagAdminPort {
  constructor(private readonly db: RoleSqlClient<"outlet_app">, private readonly audit: AuditAppendPort) {}

  async list(marketId: string): Promise<readonly FlagRecord[]> {
    return (await new PostgresFlagStore(this.db).list()).filter((r) => r.marketId === null || r.marketId === marketId);
  }

  async set(p: Principal, name: KillSwitchName, enabled: boolean, reason: string, joinTx?: Queryable): Promise<FlagRecord> {
    const actor = p.userId;
    if (actor === undefined) throw Problems.forbidden();
    const body = async (tx: Queryable): Promise<FlagRecord> => {
      const store = new PostgresFlagStore(joined(tx));
      const before = (await store.get(name, p.marketId)).find((r) => r.marketId === p.marketId);
      // FlagService's own audit port is a no-op on purpose: the chain entry with the staff reason is appended below, in this transaction.
      const svc = new FlagService({ store, audit: noopAudit });
      const after = enabled ? await svc.releaseKillSwitch(name, actor, p.marketId) : await svc.engageKillSwitch(name, actor, p.marketId);
      await this.audit.appendIn(tx, {
        marketId: p.marketId, actorType: "staff", actorId: actor, action: enabled ? "kill_switch.released" : "kill_switch.engaged", targetType: "feature_flag", targetId: name,
        diff: { before: before === undefined ? null : { enabled: before.enabled, version: before.version }, after: { enabled: after.enabled, version: after.version, reasonHash: createHash("sha256").update(reason).digest("hex") } },
        ipHash: null, deviceId: null, requestId: null,
      });
      return after;
    };
    return joinTx === undefined ? withDbContext(this.db, { kind: "user", marketId: p.marketId, userId: actor }, body) : body(joinTx);
  }
}

/** A stable id for a flag row (the table has no id column): UUID-shaped SHA-256 of key and market. */
const ruleId = (key: string, marketId: string | null): string => {
  const h = createHash("sha256").update(`${key}\u0000${marketId ?? ""}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** One flag as the contract shows it (a registered kill switch carries its description and fail mode even without a row). */
export const flagOf = (records: readonly FlagRecord[], key: string): FeatureFlagDto => {
  const def = isKillSwitchName(key) ? KILL_SWITCHES[key] : undefined;
  return {
    key,
    kind: def === undefined ? "release" : "kill_switch",
    description: def?.description ?? "",
    fail_mode: def?.failMode ?? "open",
    rules: records.filter((r) => r.key === key).map((r) => ({ id: ruleId(key, r.marketId), market_id: r.marketId, enabled: r.enabled, variant: { ...r.rules }, version: r.version })),
  };
};

/** Every registered kill switch (even without a row) plus every stored flag, sorted by key, one keyset page. */
export const flagPage = (records: readonly FlagRecord[], q: FlagsQuery): FeatureFlagPage => {
  const keys = [...new Set([...Object.keys(KILL_SWITCHES), ...records.map((r) => r.key)])].sort();
  const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor, 1)[0];
  const rest = after === undefined ? keys : keys.filter((k) => k > after);
  const page = rest.slice(0, q.limit);
  const items = page.map((key) => flagOf(records, key));
  const last = page[page.length - 1];
  return { items, next_cursor: rest.length > q.limit && last !== undefined ? encodeCursor(last) : null };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCAN_BATCH = 100;
const MAX_BATCHES = 20;
const DAY_MS = 86_400_000;

/** Audit trail reads through the SECURITY DEFINER page function (outlet_app has no SELECT on audit_log). */
export class PgAuditReader implements AuditReaderPort {
  constructor(private readonly db: RoleSqlClient<"outlet_app">) {}

  async list(p: Principal, q: AuditQuery): Promise<AuditLogEntryPage> {
    const store = new PgAuditStore(contextClient(this.db, { kind: "user", marketId: p.marketId, ...(p.userId === undefined ? {} : { userId: p.userId }) }));
    const from = q.from === undefined ? undefined : Date.parse(`${q.from}T00:00:00Z`);
    const until = q.to === undefined ? undefined : Date.parse(`${q.to}T00:00:00Z`) + DAY_MS;
    let cursor: number | undefined;
    if (q.cursor !== undefined) {
      const seq = Number(decodeCursor(q.cursor, 1)[0]);
      if (!Number.isSafeInteger(seq) || seq < 1) throw Problems.badRequest("cursor-invalid");
      cursor = seq;
    }
    const filters = { ...(q.actor_id === undefined ? {} : { actorId: q.actor_id }), ...(q.target_type === undefined ? {} : { targetType: q.target_type }) };
    const items: AuditLogEntryPage["items"] = [];
    let lastReturned: number | undefined;
    let lastScanned: number | undefined;
    let more = false;
    let done = false;
    for (let i = 0; i < MAX_BATCHES && !done; i += 1) {
      const batch = await store.list(filters, cursor, SCAN_BATCH);
      for (const e of batch.items) {
        const at = Date.parse(e.occurredAt);
        lastScanned = e.seq;
        if (from !== undefined && at < from) { done = true; break; }
        if (until !== undefined && at >= until) continue;
        if (items.length === q.limit) { more = true; done = true; break; }
        items.push({
          id: e.id, actor_type: e.actorType, actor_id: e.actorId !== null && UUID.test(e.actorId) ? e.actorId : null, action: e.action, target_type: e.targetType,
          target_id: e.targetId, reason_code: null, request_id: e.requestId ?? "", occurred_at: e.occurredAt,
        });
        lastReturned = e.seq;
      }
      cursor = batch.nextCursor;
      if (cursor === undefined) done = true;
    }
    // Scan budget spent while older rows may still match: resume after the last row looked at.
    const next = more ? lastReturned : !done ? lastScanned : undefined;
    return { items, next_cursor: next === undefined ? null : encodeCursor(String(next)) };
  }

  async verify(p: Principal, q: AuditVerifyQuery): Promise<AuditVerifyResult> {
    const store = new PgAuditStore(contextClient(this.db, { kind: "user", marketId: p.marketId, ...(p.userId === undefined ? {} : { userId: p.userId }) }));
    const r = await store.verifyChain(p.marketId, q.from_seq);
    return r.ok
      ? { ok: true, checked: r.checked, head_seq: r.headSeq ?? null, broken_seq: null, reason: null }
      : { ok: false, checked: 0, head_seq: null, broken_seq: r.brokenSeq, reason: r.reason };
  }
}

interface ElevRow {
  id: string; staff_id: string; role_code: ElevationDto["role"]; reason: string; ttl_minutes: number; status: ElevationDto["status"]; created_at: Date | string; pending_until: Date | string;
  decided_at: Date | string | null; starts_at: Date | string | null; expires_at: Date | string | null; approved_by: string | null; approval_request_id: string | null;
}
const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : iso(v));
const ELEV_SELECT = `SELECT e.id, e.staff_id, e.role_code, e.reason, e.ttl_minutes, e.status, e.created_at, e.pending_until, e.decided_at, e.starts_at, e.expires_at, e.approved_by,
  (SELECT a.id FROM approval_requests a WHERE a.target_type = 'elevation_request' AND a.target_id = e.id::text AND a.market_id = e.market_id ORDER BY a.created_at LIMIT 1) AS approval_request_id
  FROM elevation_requests e`;
const mapElev = (r: ElevRow, now: Date): ElevationDto => ({
  id: r.id, staff_id: r.staff_id, role: r.role_code, reason: r.reason.slice(0, 500), ttl_minutes: r.ttl_minutes,
  // A request nobody decided in time reads as EXPIRED even before a vote tries (and flips it) in the table.
  status: r.status === "PENDING" && now.getTime() >= new Date(r.pending_until).getTime() ? "EXPIRED" : r.status,
  created_at: iso(r.created_at), pending_until: iso(r.pending_until), decided_at: isoOrNull(r.decided_at), starts_at: isoOrNull(r.starts_at), expires_at: isoOrNull(r.expires_at),
  approved_by: r.approved_by, approval_request_id: r.approval_request_id,
});

/** Elevation requests of the staff's market (RLS elevation_requests_user_isolation: market only; the own-vs-all scope is applied here). */
export class PgElevationReader implements ElevationReaderPort {
  constructor(private readonly db: RoleSqlClient<"outlet_app">, private readonly now: () => Date = () => new Date()) {}

  private ctx(p: Principal): { kind: "user"; marketId: string; userId?: string } {
    return { kind: "user", marketId: p.marketId, ...(p.userId === undefined ? {} : { userId: p.userId }) };
  }

  async list(p: Principal, q: ElevationsQuery, all: boolean): Promise<ElevationPage> {
    const params: unknown[] = [p.marketId];
    const where: string[] = ["e.market_id = $1"];
    if (!all) where.push(`e.staff_id = $${String(params.push(p.userId ?? ""))}::uuid`);
    if (q.status !== undefined) where.push(`e.status = $${String(params.push(q.status))}`);
    if (q.cursor !== undefined) {
      const [at, id] = decodeCursor(q.cursor, 2);
      if (at === undefined || id === undefined || Number.isNaN(Date.parse(at)) || !UUID.test(id)) throw Problems.badRequest("cursor-invalid");
      where.push(`(e.created_at, e.id) < ($${String(params.push(at))}::timestamptz, $${String(params.push(id))}::uuid)`);
    }
    const rows = await withDbContext(this.db, this.ctx(p), (tx) => tx.query<ElevRow>(`${ELEV_SELECT} WHERE ${where.join(" AND ")} ORDER BY e.created_at DESC, e.id DESC LIMIT ${String(q.limit + 1)}`, params));
    const page = rows.rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const now = this.now();
    return { items: page.map((r) => mapElev(r, now)), next_cursor: rows.rows.length > q.limit && last !== undefined ? encodeCursor(iso(last.created_at), last.id) : null };
  }

  async get(p: Principal, id: string, all: boolean): Promise<ElevationDto> {
    const r = await withDbContext(this.db, this.ctx(p), (tx) => tx.query<ElevRow>(`${ELEV_SELECT} WHERE e.id = $1 AND e.market_id = $2`, [id, p.marketId]));
    const row = r.rows[0];
    if (row === undefined || (!all && row.staff_id !== p.userId)) throw Problems.notFound();
    return mapElev(row, this.now());
  }
}
