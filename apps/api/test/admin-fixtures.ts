import { randomUUID } from "node:crypto";
import type { SqlClient } from "@outlet/db";
import { bearer, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";
import type { RouteFixture } from "./route-fixtures.js";

const FINANCE_REASON = { "x-reason-code": "finance_reconciliation" };

/** A PENDING approval request filed by someone else (so the test staff may vote). */
export const seedApproval = async (raw: SqlClient, o: { requestedBy?: string; action?: string; status?: string } = {}): Promise<{ id: string; requestedBy: string }> => {
  const id = randomUUID();
  const requestedBy = o.requestedBy ?? randomUUID();
  await raw.query(
    `INSERT INTO approval_requests (id, market_id, action, target_type, target_id, payload, payload_hash, requested_by, status, expires_at, created_at)
     VALUES ($1,'EG',$2,'staff',$3,'{}'::jsonb,decode(repeat('00',32),'hex'),$4,$5,'2100-01-01','2030-01-01')`,
    [id, o.action ?? "role.grant", randomUUID(), requestedBy, o.status ?? "PENDING"],
  );
  return { id, requestedBy };
};

/** A submitted onboarding case in AUTO_CHECKS with a complete legal identity (what an admin decides on). */
export const seedKycCase = async (raw: SqlClient, state = "AUTO_CHECKS"): Promise<{ caseId: string; sellerId: string }> => {
  const sellerId = randomUUID();
  const userId = randomUUID();
  const caseId = randomUUID();
  await raw.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',now(),now())", [userId]);
  await raw.query(
    `INSERT INTO sellers (id, home_market_id, market_id, legal_type, legal_name_ar, legal_name_en, commercial_register_no, tax_card_no, governorate_code, governorate_name_ar, status)
     VALUES ($1,'EG','EG','company','شركة الاختبار','Test Co',$2,$3,'CAI','القاهرة','kyc_pending')`,
    [sellerId, `CR-${sellerId.slice(0, 8)}`, `TX-${sellerId.slice(0, 8)}`],
  );
  await raw.query("INSERT INTO kyc_cases (id, seller_id, market_id, applicant_user_id, state, submitted_at) VALUES ($1,$2,'EG',$3,$4,now())", [caseId, sellerId, userId, state]);
  return { caseId, sellerId };
};

export const seedRun = async (raw: SqlClient): Promise<{ runId: string; itemId: string }> => {
  const runId = randomUUID();
  const itemId = randomUUID();
  await raw.query(
    `INSERT INTO reconciliation_runs (id, market_id, source, counterparty, business_date, mode, status, matched_count, unmatched_count, started_at, finished_at)
     VALUES ($1,'EG','psp_settlement',$2,'2030-01-01','nightly','completed',3,1,'2030-01-01T01:00:00Z','2030-01-01T01:01:00Z')`,
    [runId, `cp-${runId.slice(0, 8)}`],
  );
  await raw.query(
    `INSERT INTO reconciliation_exceptions (id, run_id, market_id, source, counterparty, kind, ref_type, ref_id, expected_minor, actual_minor, currency, status, first_seen_at, last_seen_at)
     VALUES ($1,$2,'EG','psp_settlement','paymob','missing_settlement','payment_intent',$3,12500,NULL,'EGP','OPEN','2029-12-30T00:00:00Z','2030-01-01T01:00:00Z')`,
    [itemId, runId, randomUUID()],
  );
  return { runId, itemId };
};

const staffHeaders = (t: TestApp, token: string, extra: Record<string, string> = {}): Record<string, string> => ({ ...bearer(token), "idempotency-key": idemKey(t), ...extra });
const MISSING = "00000000-0000-4000-8000-00000000dead";

export const ADMIN_FIXTURES: Readonly<Record<string, RouteFixture>> = {
  "GET /v1/{market}/admin/approval-requests": {
    happy: async (t) => {
      await seedApproval(t.raw);
      const { token } = await t.admin(["security"]);
      return { req: { method: "GET", url: "/v1/eg/admin/approval-requests?limit=10", headers: bearer(token) }, status: 200 };
    },
  },
  "POST /v1/{market}/admin/approval-requests/{approval_request_id}/decision": {
    happy: async (t) => {
      const a = await seedApproval(t.raw);
      const { token } = await t.admin(["security"]);
      return { req: { method: "POST", url: `/v1/eg/admin/approval-requests/${a.id}/decision`, headers: staffHeaders(t, token), payload: { decision: "approve", reason: "checked the request" } }, status: 200 };
    },
    otherTenant: async (t) => {
      const { token } = await t.admin(["security"]);
      return { method: "POST", url: `/v1/eg/admin/approval-requests/${MISSING}/decision`, headers: staffHeaders(t, token), payload: { decision: "approve", reason: "checked the request" } };
    },
  },
  "GET /v1/{market}/admin/kyc-cases": {
    happy: async (t) => {
      await seedKycCase(t.raw);
      const { token } = await t.admin(["ops"]);
      return { req: { method: "GET", url: "/v1/eg/admin/kyc-cases?limit=10", headers: bearer(token) }, status: 200 };
    },
  },
  "POST /v1/{market}/admin/kyc-cases/{kyc_case_id}/decision": {
    happy: async (t) => {
      const k = await seedKycCase(t.raw);
      const { token } = await t.admin(["ops"]);
      return { req: { method: "POST", url: `/v1/eg/admin/kyc-cases/${k.caseId}/decision`, headers: staffHeaders(t, token), payload: { decision: "APPROVED", decision_reason: "documents verified" } }, status: 200 };
    },
    otherTenant: async (t) => {
      const { token } = await t.admin(["ops"]);
      return { method: "POST", url: `/v1/eg/admin/kyc-cases/${MISSING}/decision`, headers: staffHeaders(t, token), payload: { decision: "APPROVED", decision_reason: "documents verified" } };
    },
  },
  "GET /v1/{market}/admin/reconciliation/runs": {
    happy: async (t) => {
      await seedRun(t.raw);
      const { token } = await t.admin(["finance"]);
      return { req: { method: "GET", url: "/v1/eg/admin/reconciliation/runs?limit=10", headers: { ...bearer(token), ...FINANCE_REASON } }, status: 200 };
    },
  },
  "GET /v1/{market}/admin/reconciliation/runs/{reconciliation_run_id}/items": {
    happy: async (t) => {
      const r = await seedRun(t.raw);
      const { token } = await t.admin(["finance"]);
      return { req: { method: "GET", url: `/v1/eg/admin/reconciliation/runs/${r.runId}/items?limit=10`, headers: { ...bearer(token), ...FINANCE_REASON } }, status: 200 };
    },
    otherTenant: async (t) => {
      const { token } = await t.admin(["finance"]);
      return { method: "GET", url: `/v1/eg/admin/reconciliation/runs/${MISSING}/items`, headers: { ...bearer(token), ...FINANCE_REASON } };
    },
  },
};
