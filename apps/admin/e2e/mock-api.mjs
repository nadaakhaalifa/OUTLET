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
// Test knobs (POST /__control): roles; tileModes {tile_key: "not_connected" | "read_failed" | "stale"}; shortSeries (3-point sales series);
// conflict (attention writes answer 409); kycRows (how many open KYC cases the list returns); resetAttention (put the two items back).
const control = { roles: ["ops", "finance", "dpo", "security"], tileModes: {}, shortSeries: false, conflict: false, kycRows: 1 };
const log = [];
const audit = [];
const state = {
  kycStatus: "SUBMITTED",
  items: [
    { id: "a1000000-0000-4000-8000-000000000001", run_id: RUN, source_ref_type: "psp_settlement_line", source_ref_id: "11110000-0000-4000-8000-000000000001", expected: { amount_minor: "250000", currency: "EGP" }, actual: { amount_minor: "245000", currency: "EGP" }, status: "AMOUNT_MISMATCH", ticket_ref: null, first_seen_at: hoursFromNow(-120), age_days: 5 },
    { id: "a1000000-0000-4000-8000-000000000002", run_id: RUN, source_ref_type: "cod_remittance_line", source_ref_id: null, expected: { amount_minor: "99000", currency: "EGP" }, actual: null, status: "MISSING_SOURCE", ticket_ref: null, first_seen_at: hoursFromNow(-24), age_days: 1 },
  ],
};

const ATTN = "a7700000-0000-4000-8000-000000000001";
const attention = [
  { id: ATTN, kind: "refund.attention", ref_type: "refund", ref_id: "r-e2e-1", status: "OPEN", created_at: hoursFromNow(-3) },
  { id: "a7700000-0000-4000-8000-000000000002", kind: "shipment.cancel_attention", ref_type: "shipment", ref_id: "s-e2e-2", status: "ACKED", created_at: hoursFromNow(-30), acked_at: hoursFromNow(-29) },
];
// E2E-only dashboard numbers: invented for Playwright, never real. The `/__control` roles decide which tiles are forbidden (finance tiles need the finance role).
const FINANCE_ONLY = new Set(["gmv_today", "refunds_waiting", "refunds_overdue", "payouts", "recon_unmatched", "cod_unremitted", "ledger_integrity", "top_stores"]);
const dashboard = (range) => {
  const n = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const days = (count) => Array.from({ length: count }, (_, i) => day(i - count + 1));
  const egp = (minor) => ({ amount_minor: minor, currency: "EGP" });
  const ok = (key, data) => ({ key, status: "ok", as_of: new Date().toISOString(), data });
  const isFinance = control.roles.includes("finance");
  const gate = (key, tile) => (FINANCE_ONLY.has(key) && !isFinance ? { key, status: "forbidden" } : tile);
  const t = {
    orders_today: ok("orders_today", { count: 42, series_14d: days(isFinance ? 14 : 3).map((d, i) => ({ day: d, value: i + 1 })) }),
    gmv_today: gate("gmv_today", ok("gmv_today", { gmv: egp("12345600"), refunded: egp("50000"), gmv_7d: egp("98765400") })),
    sales_series: ok("sales_series", { orders: days(n).map((d, i) => ({ day: d, value: i + 1 })), gmv: isFinance ? days(n).map((d, i) => ({ day: d, value: egp(String((i + 1) * 100000)) })) : null, total_orders: 777, total_gmv: isFinance ? egp("55500000") : null }),
    orders_by_step: ok("orders_by_step", { paid_awaiting_accept: 5, accepted: 4, packed: 3, in_transit: 2, delivery_failed: 1 }),
    top_stores: gate("top_stores", ok("top_stores", { items: [{ store_id: STORE, name_ar: "متجر النيل", name_en: "Nile Store", orders: 12, gmv: egp("900000") }], other: { stores: 3, orders: 7, gmv: egp("300000") } })),
    verified_discount_share: ok("verified_discount_share", { verified: 30, live_skus: 120 }),
    seller_sla_breaches: ok("seller_sla_breaches", { late_accept: 2, late_dispatch: isFinance ? 1 : null, oldest_at: hoursFromNow(-20) }),
    cod_awaiting_confirmation: ok("cod_awaiting_confirmation", { count: 6, oldest_at: null }),
    returns_pipeline: ok("returns_pipeline", { requested: 3, in_transit: 2, awaiting_inspection: 1, inspection_overdue: 0 }),
    disputes_open: { key: "disputes_open", status: "unavailable", reason: "read_failed" },
    refunds_waiting: gate("refunds_waiting", ok("refunds_waiting", { count: 8, amount: egp("450000"), manual_review: 2, failed: 1, oldest_at: null })),
    refunds_overdue: gate("refunds_overdue", ok("refunds_overdue", { count: 0, amount: egp("0"), oldest_due_at: null })),
    payouts: gate("payouts", ok("payouts", { due_count: 9, due_net: egp("7000000"), on_hold_count: 0, on_hold_net: egp("0"), failed: 0, open_holds: 0 })),
    recon_unmatched: gate("recon_unmatched", ok("recon_unmatched", { open: 2, escalated: 0, aged_over_3d: 0, oldest_at: null })),
    cod_unremitted: gate("cod_unremitted", { key: "cod_unremitted", status: "unavailable", reason: "not_connected" }),
    ledger_integrity: gate("ledger_integrity", { key: "ledger_integrity", status: "unavailable", reason: "not_connected" }),
    kyc_queue: ok("kyc_queue", { submitted: state.kycStatus === "SUBMITTED" ? 1 : 0, needs_info: 0, oldest_at: hoursFromNow(-30) }),
    stores_moderation: ok("stores_moderation", { pending_review: 0, suspended: 1 }),
    price_enforcement: ok("price_enforcement", { active: 1, pending_review: 0, suspensions_awaiting_review: 0 }),
    listings_by_status: ok("listings_by_status", { published: 100, in_review: 5, paused: 3, blocked: 1 }),
    breaches_open: ok("breaches_open", { open: 0, next_pdpc_deadline_at: null, next_subjects_deadline_at: null }),
    dsar_queue: ok("dsar_queue", { open: 2, due_7d: 1, overdue: 1 }),
    attention_open: ok("attention_open", { open: attention.filter((a) => a.status === "OPEN").length, acked: attention.filter((a) => a.status === "ACKED").length, by_kind: { "refund.attention": 1 }, oldest_at: hoursFromNow(-30) }),
    approvals_pending: ok("approvals_pending", { for_me: 0, soonest_expires_at: null }),
    elevations_active: ok("elevations_active", { active: 0, pending: 0, scope: "market" }),
    kill_switches: ok("kill_switches", { engaged_money: [], engaged_ui: [] }),
  };
  if (control.shortSeries) {
    t.sales_series = ok("sales_series", { orders: days(3).map((d, i) => ({ day: d, value: i + 1 })), gmv: isFinance ? days(3).map((d, i) => ({ day: d, value: egp(String((i + 1) * 100000)) })) : null, total_orders: 6, total_gmv: isFinance ? egp("600000") : null });
  }
  for (const [key, mode] of Object.entries(control.tileModes)) {
    if (!t[key] || t[key].status === "forbidden") continue;
    if (mode === "stale") t[key] = { ...t[key], as_of: new Date(Date.now() - 3_600_000).toISOString() };
    else t[key] = { key, status: "unavailable", reason: mode };
  }
  const pick = (keys) => Object.fromEntries(keys.map((k) => [k, t[k]]));
  return {
    market_id: "eg", range, timezone: "Africa/Cairo", today: day(0), generated_at: new Date().toISOString(),
    sections: {
      today: pick(["orders_today", "gmv_today"]),
      sales: pick(["sales_series", "orders_by_step", "top_stores", "verified_discount_share"]),
      orders: pick(["seller_sla_breaches", "cod_awaiting_confirmation", "returns_pipeline", "disputes_open"]),
      money: pick(["refunds_waiting", "refunds_overdue", "payouts", "recon_unmatched", "cod_unremitted", "ledger_integrity"]),
      trust: pick(["kyc_queue", "stores_moderation", "price_enforcement", "listings_by_status"]),
      privacy: pick(["breaches_open", "dsar_queue"]),
      platform: pick(["attention_open", "approvals_pending", "elevations_active", "kill_switches"]),
    },
  };
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
  if (path === "/__control") {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    if (body.resetAttention) { state.kycStatus = "SUBMITTED"; attention[0].status = "OPEN"; delete attention[0].acked_at; attention[1].status = "ACKED"; delete body.resetAttention; log.length = 0; }
    Object.assign(control, body);
    return send(res, 200, control);
  }
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

  if (req.method === "GET" && rest === "dashboard") {
    const range = url.searchParams.get("range") ?? "30d";
    if (!["7d", "30d", "90d"].includes(range)) return problem(res, 400, "validation-failed");
    return send(res, 200, dashboard(range));
  }
  if (req.method === "GET" && rest === "attention") return send(res, 200, page(attention.filter((a) => a.status !== "RESOLVED")));
  const am = /^attention\/([0-9a-f-]{36})\/(ack|resolve)$/.exec(rest);
  if (req.method === "POST" && am) {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    const item = attention.find((a) => a.id === am[1]);
    if (!item) return problem(res, 404, "not-found");
    if (!req.headers["idempotency-key"]) return problem(res, 400, "idempotency-key-required");
    log.push({ method: "POST", path: `/attention-${am[2]}`, body, key: req.headers["idempotency-key"] });
    if (item.status === "RESOLVED" || control.conflict) return problem(res, 409, "conflict");
    if (am[2] === "ack") { item.status = "ACKED"; item.acked_at = new Date().toISOString(); } else { item.status = "RESOLVED"; item.resolution_code = body.resolution_code; }
    return send(res, 200, item);
  }
  if (req.method === "GET" && rest === "kyc-cases") return send(res, 200, page(Array.from({ length: control.kycRows }, (_, i) => ({ id: i === 0 ? CASE : `c0de0000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, seller_id: "5e11e000-0000-4000-8000-000000000001", legal_name_ar: `متجر النيل للأزياء ${String(i + 1)}`, status: state.kycStatus, submitted_at: hoursFromNow(-30) })).filter((c) => !url.searchParams.get("status") || c.status === url.searchParams.get("status"))));
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
  if (req.method === "GET" && rest === "audit-log/verify") return send(res, 200, { ok: true, checked: audit.length, head_seq: audit.length, broken_seq: null, reason: null });
  if (req.method === "GET" && rest === "audit-log") return send(res, 200, page(audit));
  return problem(res, 404, "not-found");
}).listen(3301, () => console.log("admin mock api on 3301"));
