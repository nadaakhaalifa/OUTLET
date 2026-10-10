import { sql, type Kysely } from "kysely";
import { z } from "zod";
import {
  ADMIN_ROLE_NAMES,
  APPROVAL_KINDS,
  KYC_STATES,
  type ApprovalRecord,
  type ElevationRecord,
  type KycState,
  type SuspensionReview,
} from "../domain/bridge";
import type {
  AdminAuditEntry,
  AdminAuditPort,
  AdminStore,
  ApprovalFilter,
  SellerKycPort,
  SellerKycView,
} from "../domain/ports";

/** Raw SQL only, rows validated with Zod (same approach as the referrals adapter). */
export type AdminDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const NullableMs = Ms.nullable();

const ApprovalRow = z.object({
  id: z.string(),
  kind: z.enum(APPROVAL_KINDS),
  subject_type: z.string(),
  subject_id: z.string(),
  amount_minor: Int.transform((s) => BigInt(s)).nullable(),
  reason_code: z.string(),
  requester_id: z.string(),
  state: z.enum(["REQUESTED", "APPROVED", "REJECTED", "EXPIRED"]),
  approver_id: z.string().nullable(),
  requested_ms: Ms,
  expires_ms: Ms,
  decided_ms: NullableMs,
  decision_note: z.string().nullable(),
});

const ElevationRow = z.object({
  id: z.string(),
  user_id: z.string(),
  role: z.enum(ADMIN_ROLE_NAMES),
  reason_code: z.string(),
  approval_id: z.string(),
  requested_ttl_ms: Ms,
  state: z.enum(["PENDING_APPROVAL", "ACTIVE", "DENIED", "REVOKED", "EXPIRED"]),
  requested_ms: Ms,
  activated_ms: NullableMs,
  expires_ms: NullableMs,
  revoked_ms: NullableMs,
  revoked_by: z.string().nullable(),
});

const ReviewRow = z.object({
  id: z.string(),
  seller_id: z.string(),
  suspended_by: z.string().nullable(),
  suspended_ms: Ms,
  due_ms: Ms,
  reason_code: z.string(),
  state: z.enum(["OPEN", "UPHELD", "REINSTATED"]),
  reviewed_by: z.string().nullable(),
  reviewed_ms: NullableMs,
});

const KycRow = z.object({
  seller_id: z.string(),
  state: z.enum(KYC_STATES),
  store_count: z.coerce.number().int(),
  names: z.array(z.string()),
  updated_ms: Ms,
});

const ms = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const APPROVAL_COLS = sql`id::text as id, kind, subject_type, subject_id, amount_minor::text as amount_minor,
  reason_code, requester_id::text as requester_id, state, approver_id::text as approver_id,
  ${ms("requested_at")} as requested_ms, ${ms("expires_at")} as expires_ms,
  ${ms("decided_at")} as decided_ms, decision_note`;
const ELEVATION_COLS = sql`id::text as id, user_id::text as user_id, role, reason_code, approval_id::text as approval_id,
  requested_ttl_ms::text as requested_ttl_ms, state, ${ms("requested_at")} as requested_ms,
  ${ms("activated_at")} as activated_ms, ${ms("expires_at")} as expires_ms,
  ${ms("revoked_at")} as revoked_ms, revoked_by::text as revoked_by`;
const REVIEW_COLS = sql`id::text as id, seller_id::text as seller_id, suspended_by::text as suspended_by,
  ${ms("suspended_at")} as suspended_ms, ${ms("due_at")} as due_ms, reason_code, state,
  reviewed_by::text as reviewed_by, ${ms("reviewed_at")} as reviewed_ms`;

const iso = (v: number): string => new Date(v).toISOString();
const isoOrNull = (v: number | null): string | null => (v === null ? null : iso(v));

const toApproval = (raw: unknown): ApprovalRecord => {
  const r = ApprovalRow.parse(raw);
  return {
    id: r.id,
    kind: r.kind,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    amountMinor: r.amount_minor,
    reasonCode: r.reason_code,
    requesterId: r.requester_id,
    state: r.state,
    approverId: r.approver_id,
    requestedAtMs: r.requested_ms,
    expiresAtMs: r.expires_ms,
    decidedAtMs: r.decided_ms,
    decisionNote: r.decision_note,
  };
};
const toElevation = (raw: unknown): ElevationRecord => {
  const r = ElevationRow.parse(raw);
  return {
    id: r.id,
    userId: r.user_id,
    role: r.role,
    reasonCode: r.reason_code,
    approvalId: r.approval_id,
    requestedTtlMs: r.requested_ttl_ms,
    state: r.state,
    requestedAtMs: r.requested_ms,
    activatedAtMs: r.activated_ms,
    expiresAtMs: r.expires_ms,
    revokedAtMs: r.revoked_ms,
    revokedBy: r.revoked_by,
  };
};
const toReview = (raw: unknown): SuspensionReview => {
  const r = ReviewRow.parse(raw);
  return {
    id: r.id,
    sellerId: r.seller_id,
    suspendedBy: r.suspended_by,
    suspendedAtMs: r.suspended_ms,
    dueAtMs: r.due_ms,
    reasonCode: r.reason_code,
    state: r.state,
    reviewedBy: r.reviewed_by,
    reviewedAtMs: r.reviewed_ms,
  };
};

const insertApprovalSql = (a: ApprovalRecord) => sql`
  insert into admin_approval_requests
    (id, kind, subject_type, subject_id, amount_minor, reason_code, requester_id, state, approver_id,
     requested_at, expires_at, decided_at, decision_note)
  values (${a.id}::uuid, ${a.kind}, ${a.subjectType}, ${a.subjectId}, ${a.amountMinor === null ? null : a.amountMinor.toString()}::bigint,
          ${a.reasonCode}, ${a.requesterId}::uuid, ${a.state}, ${a.approverId}::uuid,
          ${iso(a.requestedAtMs)}::timestamptz, ${iso(a.expiresAtMs)}::timestamptz,
          ${isoOrNull(a.decidedAtMs)}::timestamptz, ${a.decisionNote})`;

const insertElevationSql = (e: ElevationRecord) => sql`
  insert into admin_elevations
    (id, user_id, role, reason_code, approval_id, requested_ttl_ms, state, requested_at, activated_at,
     expires_at, revoked_at, revoked_by)
  values (${e.id}::uuid, ${e.userId}::uuid, ${e.role}, ${e.reasonCode}, ${e.approvalId}::uuid,
          ${String(e.requestedTtlMs)}::bigint, ${e.state}, ${iso(e.requestedAtMs)}::timestamptz,
          ${isoOrNull(e.activatedAtMs)}::timestamptz, ${isoOrNull(e.expiresAtMs)}::timestamptz,
          ${isoOrNull(e.revokedAtMs)}::timestamptz, ${e.revokedBy}::uuid)`;

export class KyselyAdminStore implements AdminStore {
  constructor(private readonly db: AdminDb) {}

  private async tx<T>(run: (trx: AdminDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as AdminDb);
    });
  }

  async insertApproval(r: ApprovalRecord): Promise<void> {
    await this.tx((t) => insertApprovalSql(r).execute(t));
  }

  async getApproval(id: string): Promise<ApprovalRecord | null> {
    const r = await this.tx((t) =>
      sql<unknown>`select ${APPROVAL_COLS} from admin_approval_requests where id = ${id}::uuid`.execute(t),
    );
    const row = r.rows[0];
    return row === undefined ? null : toApproval(row);
  }

  async saveApprovalDecision(a: ApprovalRecord): Promise<boolean> {
    const r = await this.tx((t) =>
      sql<{ id: string }>`
        update admin_approval_requests
           set state = ${a.state}, approver_id = ${a.approverId}::uuid,
               decided_at = ${isoOrNull(a.decidedAtMs)}::timestamptz, decision_note = ${a.decisionNote}
         where id = ${a.id}::uuid and state = 'REQUESTED'
         returning id::text as id`.execute(t),
    );
    return r.rows.length === 1;
  }

  async listApprovals(f: ApprovalFilter): Promise<readonly ApprovalRecord[]> {
    const states = f.states === undefined ? null : [...f.states];
    const kinds = f.kinds === undefined ? null : [...f.kinds];
    const visKinds = f.visibleTo === undefined ? null : [...f.visibleTo.kinds];
    const visActor = f.visibleTo?.actorId ?? null;
    const r = await this.tx((t) =>
      sql<unknown>`
        select ${APPROVAL_COLS} from admin_approval_requests
         where (${states}::text[] is null or state = any(${states}::text[]))
           and (${kinds}::text[] is null or kind = any(${kinds}::text[]))
           and (${f.requesterId ?? null}::uuid is null or requester_id = ${f.requesterId ?? null}::uuid)
           and (${visActor}::uuid is null or requester_id = ${visActor}::uuid or kind = any(${visKinds}::text[]))
         order by requested_at desc, id
         limit ${f.limit}`.execute(t),
    );
    return r.rows.map(toApproval);
  }

  async createElevationWithApproval(approval: ApprovalRecord, elevation: ElevationRecord): Promise<void> {
    await this.tx(async (t) => {
      await insertApprovalSql(approval).execute(t);
      await insertElevationSql(elevation).execute(t);
    });
  }

  async getElevation(id: string): Promise<ElevationRecord | null> {
    const r = await this.tx((t) => sql<unknown>`select ${ELEVATION_COLS} from admin_elevations where id = ${id}::uuid`.execute(t));
    const row = r.rows[0];
    return row === undefined ? null : toElevation(row);
  }

  async saveElevation(e: ElevationRecord, expected: ElevationRecord["state"]): Promise<boolean> {
    const r = await this.tx((t) =>
      sql<{ id: string }>`
        update admin_elevations
           set state = ${e.state}, activated_at = ${isoOrNull(e.activatedAtMs)}::timestamptz,
               expires_at = ${isoOrNull(e.expiresAtMs)}::timestamptz,
               revoked_at = ${isoOrNull(e.revokedAtMs)}::timestamptz, revoked_by = ${e.revokedBy}::uuid
         where id = ${e.id}::uuid and state = ${expected}
         returning id::text as id`.execute(t),
    );
    return r.rows.length === 1;
  }

  async liveElevations(userId: string, nowMs: number): Promise<readonly ElevationRecord[]> {
    const r = await this.tx((t) =>
      sql<unknown>`
        select ${ELEVATION_COLS} from admin_elevations
         where user_id = ${userId}::uuid and state = 'ACTIVE' and expires_at > ${iso(nowMs)}::timestamptz`.execute(t),
    );
    return r.rows.map(toElevation);
  }

  async listElevations(f: { userId?: string; activeAtMs?: number; limit: number }): Promise<readonly ElevationRecord[]> {
    const activeAt = f.activeAtMs === undefined ? null : iso(f.activeAtMs);
    const r = await this.tx((t) =>
      sql<unknown>`
        select ${ELEVATION_COLS} from admin_elevations
         where (${f.userId ?? null}::uuid is null or user_id = ${f.userId ?? null}::uuid)
           and (${activeAt}::timestamptz is null or (state = 'ACTIVE' and expires_at > ${activeAt}::timestamptz))
         order by requested_at desc, id
         limit ${f.limit}`.execute(t),
    );
    return r.rows.map(toElevation);
  }

  async insertReview(v: SuspensionReview): Promise<boolean> {
    const r = await this.tx((t) =>
      sql<{ id: string }>`
        insert into kyc_suspension_reviews
          (id, seller_id, suspended_by, suspended_at, due_at, reason_code, state, reviewed_by, reviewed_at)
        values (${v.id}::uuid, ${v.sellerId}::uuid, ${v.suspendedBy}::uuid, ${iso(v.suspendedAtMs)}::timestamptz,
                ${iso(v.dueAtMs)}::timestamptz, ${v.reasonCode}, ${v.state}, ${v.reviewedBy}::uuid,
                ${isoOrNull(v.reviewedAtMs)}::timestamptz)
        on conflict do nothing
        returning id::text as id`.execute(t),
    );
    return r.rows.length === 1;
  }

  async getReview(id: string): Promise<SuspensionReview | null> {
    const r = await this.tx((t) => sql<unknown>`select ${REVIEW_COLS} from kyc_suspension_reviews where id = ${id}::uuid`.execute(t));
    const row = r.rows[0];
    return row === undefined ? null : toReview(row);
  }

  async findOpenReviewBySeller(sellerId: string): Promise<SuspensionReview | null> {
    const r = await this.tx((t) =>
      sql<unknown>`select ${REVIEW_COLS} from kyc_suspension_reviews where seller_id = ${sellerId}::uuid and state = 'OPEN'`.execute(t),
    );
    const row = r.rows[0];
    return row === undefined ? null : toReview(row);
  }

  async saveReview(v: SuspensionReview): Promise<boolean> {
    const r = await this.tx((t) =>
      sql<{ id: string }>`
        update kyc_suspension_reviews
           set state = ${v.state}, reviewed_by = ${v.reviewedBy}::uuid, reviewed_at = ${isoOrNull(v.reviewedAtMs)}::timestamptz
         where id = ${v.id}::uuid and state = 'OPEN'
         returning id::text as id`.execute(t),
    );
    return r.rows.length === 1;
  }

  async listReviews(f: { state?: SuspensionReview["state"]; limit: number }): Promise<readonly SuspensionReview[]> {
    const r = await this.tx((t) =>
      sql<unknown>`
        select ${REVIEW_COLS} from kyc_suspension_reviews
         where (${f.state ?? null}::text is null or state = ${f.state ?? null})
         order by due_at, id
         limit ${f.limit}`.execute(t),
    );
    return r.rows.map(toReview);
  }
}

/**
 * Seller KYC read model over `stores` (0013): one row per seller, state taken from the stores'
 * denormalised seller_kyc_state cache (all stores of a seller carry the same value). Writes go
 * through compare-and-set so two admins cannot both move the same seller.
 */
export class KyselySellerKyc implements SellerKycPort {
  constructor(private readonly db: AdminDb) {}

  private async tx<T>(run: (trx: AdminDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as AdminDb);
    });
  }

  private static readonly COLS = sql`seller_id::text as seller_id, min(seller_kyc_state) as state,
    count(*)::text as store_count, array_agg(name_ar order by name_ar) as names,
    floor(extract(epoch from max(updated_at)) * 1000)::text as updated_ms`;

  async list(f: { states?: readonly KycState[]; limit: number }): Promise<readonly SellerKycView[]> {
    const states = f.states === undefined ? null : [...f.states];
    const r = await this.tx((t) =>
      sql<unknown>`
        select ${KyselySellerKyc.COLS} from stores
         group by seller_id
        having (${states}::text[] is null or min(seller_kyc_state) = any(${states}::text[]))
         order by max(updated_at), seller_id
         limit ${f.limit}`.execute(t),
    );
    return r.rows.map(toKycView);
  }

  async get(sellerId: string): Promise<SellerKycView | null> {
    const r = await this.tx((t) =>
      sql<unknown>`select ${KyselySellerKyc.COLS} from stores where seller_id = ${sellerId}::uuid group by seller_id`.execute(t),
    );
    const row = r.rows[0];
    return row === undefined ? null : toKycView(row);
  }

  async setState(sellerId: string, from: KycState, to: KycState, nowMs: number): Promise<boolean> {
    const r = await this.tx((t) =>
      sql<{ id: string }>`
        update stores set seller_kyc_state = ${to}, updated_at = ${iso(nowMs)}::timestamptz
         where seller_id = ${sellerId}::uuid and seller_kyc_state = ${from}
         returning id::text as id`.execute(t),
    );
    return r.rows.length > 0;
  }
}

const toKycView = (raw: unknown): SellerKycView => {
  const r = KycRow.parse(raw);
  return { sellerId: r.seller_id, state: r.state, storeCount: r.store_count, storeNames: r.names, updatedAtMs: r.updated_ms };
};

const YYYY_MM = (ms0: number): string => new Date(ms0).toISOString().slice(0, 7);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Appends to the hash-chained audit_log of 0005 (the trigger assigns seq and hashes). One chain per
 * month: chain_id admin:YYYY-MM. Reason code goes in its own column; the diff is already redacted.
 */
export class KyselyAdminAudit implements AdminAuditPort {
  constructor(private readonly db: AdminDb) {}

  async append(e: AdminAuditEntry): Promise<void> {
    const targetId = e.targetId !== null && UUID.test(e.targetId) ? e.targetId : null;
    await this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      await sql`
        insert into audit_log (occurred_at, chain_id, actor_type, actor_id, action, target_type, target_id,
                               diff_redacted, request_id, reason_code)
        values (${iso(e.atMs)}::timestamptz, ${`admin:${YYYY_MM(e.atMs)}`},
                ${e.actorId === null ? "system" : "staff"}, ${e.actorId}::uuid, ${e.action},
                ${e.targetType}, ${targetId}::uuid, ${JSON.stringify(e.diff)}::jsonb, ${e.requestId}, ${e.reasonCode})`.execute(trx);
    });
  }
}
