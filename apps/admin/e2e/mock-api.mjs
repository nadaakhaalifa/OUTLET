// TEST-ONLY stateful mock of the admin routes in docs/api/openapi.yaml (real response shapes, in-memory state). Never used outside Playwright.
// It also answers the gap routes (document URL) the contract does not define yet; routes it leaves out answer 404 on purpose
// (elevations, audit-log/verify) so the UI's "not on the server yet" states are exercised honestly.
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";

const TOKEN = "e2e-admin-token";
const STAFF = "5a1f0000-0000-4000-8000-000000000001";
const CASE = "c0de0000-0000-4000-8000-000000000001";
const DOC = "d0c00000-0000-4000-8000-000000000001";
const RUN = "7e100000-0000-4000-8000-000000000001";
const STORE = "5702e000-0000-4000-8000-000000000001";
const REASON = /^[a-z_]{3,40}(:[A-Za-z0-9-]{1,40})?$/;
const hoursFromNow = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
const control = { roles: ["ops", "finance", "dpo", "security"] };
const log = [];
const audit = [];
const state = {
  kycStatus: "SUBMITTED",
  items: [
    { id: "a1000000-0000-4000-8000-000000000001", run_id: RUN, source_ref_type: "psp_settlement_line", source_ref_id: "11110000-0000-4000-8000-000000000001", expected: { amount_minor: "250000", currency: "EGP" }, actual: { amount_minor: "245000", currency: "EGP" }, status: "AMOUNT_MISMATCH", ticket_ref: null, first_seen_at: hoursFromNow(-120), age_days: 5 },
    { id: "a1000000-0000-4000-8000-000000000002", run_id: RUN, source_ref_type: "cod_remittance_line", source_ref_id: null, expected: { amount_minor: "99000", currency: "EGP" }, actual: null, status: "MISSING_SOURCE", ticket_ref: null, first_seen_at: hoursFromNow(-24), age_days: 1 },
  ],
};

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": status >= 400 ? "application/problem+json" : "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const problem = (res, status, code) => send(res, status, { type: `urn:outlex:problem:${code}`, title: code, status, code, request_id: "e2e" });
const readBody = (req) => new Promise((resolve) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => resolve(Buffer.concat(c))); });
const page = (items) => ({ items, next_cursor: null });
const note = (req, action, target, reason) => {
  log.push({ method: req.method, path: new URL(req.url, "http://x").pathname, reason: req.headers["x-reason-code"] ?? null });
  audit.unshift({ id: randomUUID(), actor_type: "staff", actor_id: STAFF, action, target_type: target, target_id: CASE, reason_code: reason ?? null, request_id: "e2e", occurred_at: new Date().toISOString() });
};

const kycCase = (revealed) => ({
  case: {
    id: CASE, seller_id: "5e11e000-0000-4000-8000-000000000001", kind: "seller", status: state.kycStatus, submitted_at: hoursFromNow(-30), decided_at: null, decision_reason: null, version: 1,
    documents: [{ id: DOC, doc_type: "commercial_register", media_id: "3ed1a000-0000-4000-8000-000000000001", verified: false, expires_on: null, created_at: hoursFromNow(-30) }],
    required_documents: ["commercial_register", "tax_card"],
    signatory: { id: "51600000-0000-4000-8000-000000000001", full_name_masked: "م*** ع***", national_id_last4: "4821", role_title: null, verified_at: null },
  },
  seller_legal: { legal_name_ar: "متجر النيل للأزياء", legal_name_en: null, commercial_register_no: "CR-884201", tax_card_no: "TC-552019", governorate_name_ar: "القاهرة" },
  checks: [{ check_type: "register_lookup", result: "pass", score_bp: null, provider: "e2e", checked_at: hoursFromNow(-29) }],
  ...(revealed ? { signatory_revealed: { full_name: "منى عبد الله", national_id: "29801011234821", phone_e164: "+201000000000" } } : {}),
});

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  if (path === "/health") return send(res, 200, { ok: true });
  if (path === "/__control") { Object.assign(control, JSON.parse((await readBody(req)).toString() || "{}")); return send(res, 200, control); }
  if (path === "/__log") return send(res, 200, log);
  const m = /^\/v1\/eg\/admin\/(.*)$/.exec(path);
  if (!m) return problem(res, 404, "not-found");
  const rest = m[1];

  if (req.method === "POST" && rest === "auth/passkey/options") {
    await readBody(req);
    return send(res, 200, { challenge_id: randomUUID(), public_key: { challenge: "Y2hhbGxlbmdl", userVerification: "required" }, expires_at: hoursFromNow(0.1) });
  }
  if (req.method === "POST" && rest === "auth/passkey/verify") {
    await readBody(req);
    return send(res, 200, { staff_id: STAFF, market_id: "eg", roles: control.roles, amr: ["hwk"], expires_at: hoursFromNow(8) }, { "x-session-token": TOKEN });
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return problem(res, 401, "unauthenticated");
  if (rest === "auth/logout") { await readBody(req); return send(res, 204, {}); }

  if (req.method === "GET" && rest === "kyc-cases") return send(res, 200, page([{ id: CASE, seller_id: "5e11e000-0000-4000-8000-000000000001", legal_name_ar: "متجر النيل للأزياء", status: state.kycStatus, submitted_at: hoursFromNow(-30) }].filter((c) => !url.searchParams.get("status") || c.status === url.searchParams.get("status"))));
  if (req.method === "GET" && rest === `kyc-cases/${CASE}`) {
    const reason = req.headers["x-reason-code"];
    if (reason !== undefined) { if (!REASON.test(String(reason))) return problem(res, 422, "validation-failed"); note(req, "kyc.signatory.reveal", "kyc_case", reason); }
    return send(res, 200, kycCase(reason !== undefined));
  }
  if (req.method === "GET" && rest === `kyc-cases/${CASE}/documents/${DOC}/url`) {
    const reason = req.headers["x-reason-code"];
    if (reason === undefined || !REASON.test(String(reason))) return problem(res, 400, "reason-code-required");
    note(req, "kyc.document.open", "kyc_document", reason);
    return send(res, 200, { url: "https://files.example.test/signed/commercial-register.pdf?sig=e2e", expires_at: hoursFromNow(0.1) });
  }
  if (req.method === "POST" && rest === `kyc-cases/${CASE}/decision`) {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    log.push({ method: "POST", path: `/kyc-decision`, body });
    state.kycStatus = body.decision;
    note(req, "kyc.decision", "kyc_case", null);
    return send(res, 200, { ...kycCase(false).case, status: state.kycStatus, decision_reason: body.decision_reason });
  }

  if (req.method === "GET" && rest === "price-integrity/enforcement-actions") return send(res, 200, page([{ id: randomUUID(), store_id: STORE, finding_id: null, sku_id: null, action: "badge_removed", starts_at: hoursFromNow(-48), expires_at: hoursFromNow(600), status: "ACTIVE", human_review_required: false, reviewed_by: null, reviewed_at: null }]));
  if (req.method === "GET" && rest === "price-integrity/findings") return send(res, 200, page([]));
  if (req.method === "GET" && rest === `price-integrity/stores/${STORE}/trust`) return send(res, 200, { store_id: STORE, score: 62, violations_90d: 2, components: {}, computed_at: hoursFromNow(-2), recent_findings: [] });

  if (req.method === "GET" && rest === "reconciliation/runs") return send(res, 200, page([{ id: RUN, source: "psp_settlement", counterparty: "paymob", business_date: new Date().toISOString().slice(0, 10), mode: "nightly", status: "COMPLETED", matched_count: 120, unmatched_count: 2, started_at: hoursFromNow(-6), finished_at: hoursFromNow(-5) }]));
  if (req.method === "GET" && rest === `reconciliation/runs/${RUN}/items`) return send(res, 200, page(state.items.filter((i) => i.status !== "RESOLVED")));
  const rm = /^reconciliation\/items\/([0-9a-f-]{36})\/resolve$/.exec(rest);
  if (req.method === "POST" && rm) {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    const item = state.items.find((i) => i.id === rm[1]);
    if (!item) return problem(res, 404, "not-found");
    item.status = "RESOLVED"; item.ticket_ref = body.ticket_ref;
    return send(res, 200, { item, approval_request_id: null });
  }
  if (req.method === "GET" && rest === "approval-requests") return send(res, 200, page([]));
  if (req.method === "GET" && rest === "privacy/requests") return send(res, 200, page([
    { id: randomUUID(), subject_ref: "usr_9f2c", kind: "export", status: "PENDING", blocked_reason: null, due_at: hoursFromNow(40), cooling_until: null, completed_at: null, created_at: hoursFromNow(-32) },
    { id: randomUUID(), subject_ref: "usr_a41d", kind: "delete", status: "PENDING", blocked_reason: null, due_at: hoursFromNow(-5), cooling_until: null, completed_at: null, created_at: hoursFromNow(-725) },
  ]));
  if (req.method === "GET" && rest === "privacy/consent-stats") return send(res, 200, { as_of: new Date().toISOString(), purposes: [{ purpose_code: "marketing_push", purpose_version: 1, granted_count: 412, withdrawn_30d: 9 }] });
  if (req.method === "GET" && rest === "privacy/breaches") return send(res, 200, page([]));
  if (req.method === "GET" && rest === "privacy/transfer-register") return send(res, 200, page([]));
  if (req.method === "GET" && rest === "audit-log") return send(res, 200, page(audit));
  return problem(res, 404, "not-found");
}).listen(3301, () => console.log("admin mock api on 3301"));
