// Fixture gateway for browser e2e. The DEV_FIXTURES API has no seller/admin auth, so the apps' server-side
// loaders would only ever see 401/404. This gateway answers the authenticated reads the pages need with
// schema-valid fixtures and forwards EVERYTHING ELSE to the real API (so real 401/404 states are exercised).
import http from "node:http";

const UP = Number(process.env.UPSTREAM_PORT ?? 3917);
const PORT = Number(process.env.GATEWAY_PORT ?? 3918);
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const m = (a) => ({ amount: String(a), currency: "EGP" });
const page = (items) => ({ items, page: { next_cursor: null, has_more: false } });
const meta = { store_id: U(1), from: iso(now - 30 * 864e5), to: iso(now), freshness: { as_of: iso(now - 5 * 6e4), lag_ms: 300000, slo_ms: 900000, within_slo: true }, k_anonymity_min: 50 };

// Derived from the registry so the fixture can never drift from the real key list.
import fs from "node:fs";
const REGISTRY = new URL("../../packages/feature-flags/src/registry.ts", import.meta.url);
const KEYS = [...new Set([...fs.readFileSync(REGISTRY, "utf8").matchAll(/^\s*"(kill\.[a-z0-9._]+)":\s*\{\s*description/gm)].map((x) => x[1]))];
if (KEYS.length < 38) throw new Error("registry parse found only " + KEYS.length + " kill switches");
const flags = KEYS.map((k, i) => ({ key: k, kind: "kill_switch", description: k, enabled: k !== "kill.creator_payouts" && i % 3 === 0, is_default: k === "kill.creator_payouts" || i % 3 !== 0 })); // creator payouts are engaged OFF

const sku = (n) => ({ id: U(100 + n), size_label: "M", price: m(129900), on_hand: 4, available: 4 });
const product = { id: U(10), status: "active", title: { ar: "فستان كتان", en: "Linen dress" }, category_id: U(11), condition: "new_with_tags", skus: [sku(1)], price_claim_state: "none", updated_at: iso(now) };
const order = { id: U(20), status: "PAID", lines: [{ id: U(21), sku_id: U(101), title: { ar: "فستان كتان", en: "Linen dress" }, size_label: "M", qty: 1, unit_price: m(129900) }], subtotal: m(129900), shipping: m(0), buyer: { first_name: "Mona", governorate_code: "CAI" }, accept_by: iso(now + 3 * 36e5), payment_type: "prepaid", created_at: iso(now - 36e5) };

const adm = {
  "/v1/admin/me": { user_id: U(900), roles: ["ops", "finance", "dpo", "security", "super_admin", "trust_safety"], standing_roles: ["ops", "finance", "dpo", "security"], assurance: "passkey", posture: { ip_allowlisted: true, device_trusted: true } },
  "/v1/admin/kill-switches": { items: flags },
  "/v1/admin/flags": { items: flags },
  "/v1/admin/approvals": { items: [{ id: U(30), kind: "refund", subject_type: "order", subject_id: "o-1", amount_minor: "500000", currency: "EGP", reason_code: "goodwill", requester_id: U(901), state: "pending", approver_id: null, requested_at: iso(now - 36e5), expires_at: iso(now + 864e5), decided_at: null }] },
  "/v1/admin/elevations/mine": { items: [] },
  "/v1/admin/elevations": { items: [] },
  "/v1/admin/kyc/queue": { items: [{ seller_id: U(40), kyc_state: "SUBMITTED", store_count: 1, store_names: ["Nile Outlet"], updated_at: iso(now) }] },
  "/v1/admin/kyc/suspension-reviews": { items: [] },
  "/v1/admin/privacy/requests": { summary: { open: 1, overdue: 0, due_within_24h: 1, by_kind: { export: 1 } }, items: [{ id: U(50), type: "export", subject_ref: "u-***1", status: "open", received_at: iso(now - 864e5), due_at: iso(now + 864e5), ms_remaining: 864e5, overdue: false, ready_target_at: null, ready_target_missed: false, cooling_ends_at: null, blockers: [] }] },
  "/v1/admin/privacy/breaches": { items: [] },
  "/v1/admin/ledger/balances": { items: [{ account: "psp_clearing:kashier", type: "psp_clearing", owner_type: "psp", owner_id: "kashier", sub_key: null, currency: "EGP", raw: "250000", balance: "250000", posting_count: 3 }] },
  "/v1/admin/finance/reconciliation/tickets": { items: [], page: { next_cursor: null, has_more: false } },
};
const sel = {
  "/v1/seller/store": { id: U(1), slug: "nile-outlet", name: { ar: "منفذ النيل", en: "Nile Outlet" }, status: "active", legal_identity: { legal_name: "Nile Outlet LLC", governorate: "Cairo" }, accept_sla_hours: 24, dispatch_sla_hours: 48, kyc_status: "APPROVED" },
  [`/v1/seller/stores/${U(1)}/analytics/sales`]: { gmv: m(25000000), commission: m(3000000), net: m(22000000), units: 210, orders: 160, aov: m(156250), repeat_rate_bps: null, repeat_rate_suppressed: true, meta },
  [`/v1/seller/stores/${U(1)}/analytics/funnel`]: { total: { steps: [{ stage: "impression", count: 9000, from_previous_bps: null, exceeds_previous: false }, { stage: "view", count: 3000, from_previous_bps: 3333, exceeds_previous: false }], overall_bps: 3333 }, meta },
  [`/v1/seller/stores/${U(1)}/analytics/traffic`]: { store_views: 3000, product_views: 5000, unique_visitors: 1900, by_source: { items: [{ key: "feed", events: 1200 }], suppressed_cells: 3 }, meta },
  [`/v1/seller/stores/${U(1)}/analytics/geography`]: { governorates: [{ governorate: "Cairo", orders: 90, gmv: m(14000000) }], suppressed_governorates: 4, meta },
  [`/v1/seller/stores/${U(1)}/analytics/aging`]: { alerts: [], meta },
  "/v1/seller/products": page([product]),
  [`/v1/seller/products/${U(10)}`]: product,
  "/v1/seller/orders": page([order]),
};

// --- design-review fixtures (brand onboarding, settings, admin brand queue). Additive; schema-valid per
// apps/seller-web/src/api/schemas-onboarding.ts and apps/admin-web/src/api/brand-schemas.ts.
const appDoc = (n, code, review) => ({ id: U(700 + n), requirement_code: code, original_filename: `${code}.pdf`, content_type: "application/pdf", size_bytes: 482000, upload_status: "uploaded", scan_status: "clean", review_status: review, review_note_public: null, created_at: iso(now - 3 * 864e5) });
const brandApp = (n, status, extra = {}) => ({
  id: U(n), status, brand_kind: "local", country: "EG", brand_name: n === 60 ? "Nile Outlet" : "Cairo Linen House", legal_name: "Nile Outlet LLC",
  registration: { commercial_register_no: "123456", tax_card_no: "987-654-321" }, ownership_basis: "brand_owner", website_domain: "nile-outlet.example",
  domain_verification: { method: "dns_txt", domain: "nile-outlet.example", status: "verified", verified_at: iso(now - 2 * 864e5) },
  documents: [appDoc(1, "commercial_register", "accepted"), appDoc(2, "tax_card", "unreviewed")], requested_items: [],
  decision: null, decision_due_at: iso(now + 36 * 36e5), store_id: null, allowed_actions: ["edit", "withdraw"], appeal_used: false,
  submitted_at: iso(now - 864e5), created_at: iso(now - 4 * 864e5), updated_at: iso(now - 36e5), ...extra,
});
const appA = brandApp(60, "IN_REVIEW");
const appB = brandApp(61, "NEEDS_INFO", { requested_items: [
  { code: "tax_card", kind: "document", message_ar: "الرجاء رفع صورة أوضح للبطاقة الضريبية.", message_en: "Please upload a clearer image of the tax card.", satisfied: false },
  { code: "website_domain", kind: "domain_verification", message_ar: "أكد ملكية النطاق.", message_en: "Confirm ownership of the domain.", satisfied: true } ],
  decision: { decision: "needs_info", reason_code: "documents_unreadable", message_ar: "بعض المستندات غير مقروءة.", message_en: "Some documents are not readable.", decided_at: iso(now - 36e5), appeal_allowed: false },
  allowed_actions: ["edit", "upload_document", "resubmit", "withdraw"] });
const reqs = { kind: "local", country: "EG", version: 3, website_verification: "required_if_website",
  fields: [{ code: "commercial_register_no", label_ar: "رقم السجل التجاري", label_en: "Commercial register number", required: true, format: "commercial_register_no" }],
  documents: [{ code: "commercial_register", label_ar: "السجل التجاري", label_en: "Commercial register", required: true, accepts: ["pdf", "jpg", "png"], max_bytes: 10485760 },
              { code: "tax_card", label_ar: "البطاقة الضريبية", label_en: "Tax card", required: true, accepts: ["pdf", "jpg", "png"], max_bytes: 10485760 }] };
const S1 = `/v1/seller/stores/${U(1)}`;
// Seller me fixture (dashboard foundations track 2): owner on an active store, every permission key true.
const SELLER_PERMISSION_KEYS = ["store_product.read", "store_product.create", "store_product.update", "store_product.delete", "store_inventory.read", "store_inventory.create", "store_inventory.update", "store_order.read", "store_order.update", "store_return.read", "store_return.update", "store_payout.read", "store_settings.read", "store_settings.update", "store_staff.read", "store_staff.create", "store_staff.update", "store_staff.delete", "analytics.read", "analytics.export"];
const sellerMembership = { store_id: U(1), role: "owner", store_status: "active", permissions: Object.fromEntries(SELLER_PERMISSION_KEYS.map((k) => [k, true])) };
const design = {
  "/v1/seller/me": { user_id: U(901), memberships: [sellerMembership], server_time: iso(now) },
  [`${S1}/me`]: { user_id: U(901), membership: sellerMembership, server_time: iso(now) },
  "/v1/seller/applications": { items: [appA, appB], page: { next_cursor: null } },
  [`/v1/seller/applications/${U(60)}`]: appA,
  [`/v1/seller/applications/${U(61)}`]: appB,
  "/v1/seller/applications/requirements": reqs,
  "/v1/seller/onboarding-checklist": { store_id: U(1), items: [
    { code: "complete_store_profile", done: true, required_for_publish: true }, { code: "add_payout_iban", done: true, required_for_publish: true },
    { code: "enrol_eta_receipts", done: false, required_for_publish: false }, { code: "add_first_product", done: false, required_for_publish: true },
    { code: "set_shipping_origin", done: false, required_for_publish: true }, { code: "invite_team", done: false, required_for_publish: false } ] },
  [`${S1}/profile`]: { store_id: U(1), name_ar: "منفذ النيل", name_en: "Nile Outlet", description_ar: "ملابس بأسعار حقيقية.", description_en: "Fashion at verified prices.", social_links: {},
    return_policy: { change_of_mind_days: 14, defect_days: 30, statutory_minimum: { change_of_mind_days: 14, defect_days: 30 } },
    free_delivery_threshold: m(200000), vacation: { enabled: false, until: null, eta_extra_days: 0 }, version: 4 },
  [`${S1}/payout-account`]: { configured: true, iban_masked: "EG** **** **** **** **** **** *1234", iban_last4: "1234", name_match_score: 0.97, payouts_held: false, held_until: null, activates_at: null, created_at: iso(now - 9 * 864e5) },
  [`${S1}/payout-account/history`]: { items: [{ kind: "created", at: iso(now - 9 * 864e5) }] },
  [`${S1}/shipping`]: { configured: true, origin: { governorate_code: "C", city_code: "NASR", street: "Abbas El Akkad", building: "12", landmark: "Next to the metro", contact_name: "Warehouse", contact_phone_masked: "01*****789" }, handling_time_hours: 48, courier_preferences: {}, packaging_options: ["box"] },
  [`${S1}/notification-preferences`]: { preferences: { orders: { push: true, email: true }, finance: { push: false, email: true } }, transactional_events: ["order.paid"] },
  [`${S1}/team`]: { members: [{ user_id: U(901), role: "owner", phone_masked: "01*****321", joined_at: iso(now - 20 * 864e5) }], invites: [] },
  [`${S1}/eta-enrolment`]: { status: "not_requested", failure_code: null, requested_at: null, last_checked_at: null, last_verified_at: null },
  "/v1/admin/brand-applications": { items: [
    { id: U(60), brand_name: "Nile Outlet", brand_kind: "local", country: "EG", status: "IN_REVIEW", assignee_id: null, submitted_at: iso(now - 864e5), decision_due_at: iso(now + 36 * 36e5), sla_breached: false, risk_score: 18 },
    { id: U(61), brand_name: "Cairo Linen House", brand_kind: "local", country: "EG", status: "NEEDS_INFO", assignee_id: U(900), submitted_at: iso(now - 2 * 864e5), decision_due_at: iso(now + 6 * 36e5), sla_breached: false, risk_score: 52 },
    { id: U(62), brand_name: "Atelier Maadi", brand_kind: "global", country: "TR", status: "SUBMITTED", assignee_id: null, submitted_at: iso(now - 4 * 864e5), decision_due_at: iso(now - 36e5), sla_breached: true, appeal: false, high_risk_country: true, risk_score: 81 },
    { id: U(63), brand_name: "Delta Denim", brand_kind: "local", country: "EG", status: "APPROVED", assignee_id: null, submitted_at: iso(now - 6 * 864e5), decision_due_at: iso(now - 3 * 864e5), risk_score: 7 } ], page: { next_cursor: null, has_more: false } },
  [`/v1/admin/brand-applications/${U(60)}`]: { application: { ...appA, documents: appA.documents }, assignee_id: null, decision_due_at: iso(now + 36 * 36e5), sla_breached: false, pending_cosign: false,
    auto_checks: [{ code: "document_scan", result: "pass", ran_at: iso(now - 864e5) }, { code: "sanctions_screen", result: "pass", ran_at: iso(now - 864e5) }, { code: "trademark_register", result: "warn", detail: "Owner name differs", ran_at: iso(now - 864e5) }],
    history: [{ at: iso(now - 4 * 864e5), actor_type: "applicant", event: "created" }, { at: iso(now - 864e5), actor_type: "applicant", event: "submitted", from_status: "DRAFT", to_status: "SUBMITTED" }, { at: iso(now - 864e5), actor_type: "system", event: "auto_checks", from_status: "SUBMITTED", to_status: "IN_REVIEW" }] },
};

// --- shopper-web (public read) fixtures. Additive; schema-valid per packages/api-client generated schemas.
// Ids: store U(801), verified-claim product U(810), plain product U(811), drops U(820..821).
const SHOP_ORIGIN = process.env.SHOPPER_E2E_ORIGIN ?? "http://localhost:3003";
// Public wire shapes (docs/api/openapi.yaml PublicStoreSummary/PublicStore/PublicProduct): no is_favorite, no per-user fields.
const pubStore = { id: U(801), slug: "nile-outlet", name: { ar: "منفذ النيل", en: "Nile Outlet" }, kind: "local", logo_url: `${SHOP_ORIGIN}/og-default.png`, verified_badge: true, max_verified_discount_pct: 23, rating: null, rating_count: 0, follower_count: 12, live_drop: true };
const claim = { reference_price: m(129900), discount_pct: 23, claim_id: U(850) };
// Fixture ids for error states: U(812) delisted product -> 410; U(802) suspended store -> 404 (generic public 404 below).
const pubPrice = (price, badge, extra) => ({ price: m(price), badge, ...extra });
const pubSku = (n, price, badge, extra = {}) => ({ id: U(830 + n), size_label: n === 2 ? "L" : "M", available: n !== 2, units_left: n === 1 ? 3 : null, price: pubPrice(price, badge, extra) });
const shProd = (n, title, price, badge, extra) => ({ id: U(n), title, store: pubStore, image_url: `${SHOP_ORIGIN}/og-default.png`, price: pubPrice(price, badge, extra), condition: "new_with_tags", sponsored: false,
  description: { ar: "فستان كتان بقصة مستقيمة.", en: "Straight-cut linen dress." }, images: [{ url: `${SHOP_ORIGIN}/og-default.png` }],
  skus: [pubSku(1, price, badge, extra), pubSku(2, price, badge, extra)], material: "linen", return_eligibility: { returnable: true, window_days: 14 },
  seller_legal_identity_visible: true, seller_legal_identity: { legal_name: "Nile Outlet LLC", commercial_register_no: "123456", tax_card_no: "987-654-321", governorate: "Cairo" }, size_chart_available: true, updated_at: iso(now) });
const pClaim = shProd(810, { ar: "فستان كتان", en: "Linen dress" }, 99900, "verified_discount", claim);
const pPlain = shProd(811, { ar: "قميص قطن", en: "Cotton shirt" }, 45900, "none", {});
const summ = (p) => ({ id: p.id, title: p.title, store: p.store, image_url: p.image_url, price: p.price, condition: p.condition, sponsored: false });
const dropBase = (n, type, state, startsMs, endsMs) => ({ id: U(n), store_id: U(801), type, state, paused: false, title: n === 820 ? "Linen week" : "Mystery box night", starts_at: iso(startsMs), early_access_at: null, ends_at: iso(endsMs), limits: { per_user: 2, per_device: 2 },
  mystery: type === "mystery_box" ? { min_value: "200000", max_value: "400000", guaranteed_min: "200000", currency: "EGP" } : null, ladder: [], server_time: iso(now), currency: "EGP", items: [{ sku_id: U(831), price: "99900" }, { sku_id: U(832), price: "45900" }] });
const d1 = dropBase(820, "public", "LIVE", now - 36e5, now + 5 * 36e5);
const d2 = dropBase(821, "mystery_box", "SCHEDULED", now + 24 * 36e5, now + 30 * 36e5);
const shopper = {
  "/v1/drops": { items: [d1, d2], page: { next_cursor: null, has_more: false } },
  [`/v1/drops/${U(820)}`]: { ...d1, social_proof: { bought_24h: 0, viewing_now: 0, remaining: null }, waitlist_size: null },
  [`/v1/drops/${U(821)}`]: { ...d2, social_proof: { bought_24h: 0, viewing_now: 0, remaining: null }, waitlist_size: null },
  "/v1/public/stores": { items: [pubStore], page: { next_cursor: null, has_more: false } },
  [`/v1/public/stores/${U(801)}`]: { ...pubStore, description: { ar: "ملابس بأسعار موثّقة.", en: "Fashion at verified prices." }, legal_identity: { legal_name: "Nile Outlet LLC", commercial_register_no: "123456", tax_id: "987-654-321", governorate: "Cairo" }, free_delivery_threshold: m(200000), status: "active" },
  "/v1/public/search": { items: [summ(pClaim), summ(pPlain)], page: { next_cursor: null, has_more: false }, total_estimate: 2 },
  [`/v1/public/products/${U(810)}`]: pClaim,
  [`/v1/public/products/${U(811)}`]: pPlain,
  "/v1/public/sitemap/stores/1": { items: [{ id: U(801), slug: "nile-outlet" }], page: { number: 1, next_page: null } },
  "/v1/public/sitemap/products/1": { items: [{ id: U(810), lastmod: iso(now) }, { id: U(811), lastmod: iso(now) }], page: { number: 1, next_page: null } },
  [`/v1/products/${U(810)}/price-evidence`]: { product_id: U(810), tier: "E2", display_kind: "verified_discount", reference_amount: m(129900), percentage: 23, evidence_classes: ["INTERNAL"] },
  [`/v1/products/${U(811)}/price-evidence`]: { product_id: U(811), tier: "E0", display_kind: "plain", evidence_classes: [] },
  [`/v1/products/${U(810)}/price-history`]: { product_id: U(810), window_days: 30, points: [{ valid_from: iso(now - 20 * 864e5), valid_to: iso(now - 5 * 864e5), price: m(129900) }, { valid_from: iso(now - 5 * 864e5), valid_to: null, price: m(99900) }], lowest_30d: m(99900) },
  [`/v1/products/${U(811)}/price-history`]: { product_id: U(811), window_days: 30, points: [], lowest_30d: null },
};

// --- Phase 3 wave C fixtures (additive): seller forecasts + store channels, admin creators, creator payouts, ranking v2.
const fcInterval = { p10: 4, p50: 9, p90: 15, nominal_coverage_bps: 8000 };
const p3sel = {
  [`/v1/seller/stores/${U(1)}/forecasts`]: {
    store_id: U(1), as_of_date: iso(now).slice(0, 10), generated_at: iso(now - 6 * 36e5), stale: true, advice_only: true,
    notice: { en: "Estimates are advice only. The range shows where demand is expected to fall 8 times out of 10. A new price will not show a % off unless it is verified.", ar: "التقديرات للاسترشاد فقط. يوضح النطاق أين يُتوقع أن يقع الطلب في 8 حالات من كل 10. لن يظهر السعر الجديد بخصم % ما لم يتم التحقق منه." },
    items: [
      { scope: "category_size", scope_key: "dress|M", horizon_days: 7, status: "ok", reason_codes: ["weekly_seasonality", "model_beat_baseline"], model_version: "m1", model: "ets_seasonal", interval: fcInterval, history: { comparable_units: 64, observed_days: 120 }, backtest: { coverage_bps: 7800 } },
      { scope: "category_size", scope_key: "dress|XL", horizon_days: 7, status: "insufficient_history", reason_codes: ["units_below_minimum"], model_version: "m1" },
      { scope: "category_governorate", scope_key: "dress|Aswan", horizon_days: 14, status: "suppressed", reason_codes: ["k_anonymity_below_minimum"], model_version: "m1" },
    ],
    has_more: false,
  },
  [`/v1/seller/stores/${U(1)}/channels`]: { items: [{ id: U(950), kind: "odoo", status: "active", target_id: null, has_secret: true, created_at: iso(now - 5 * 864e5) }] },
};
const p3adm = {
  "/v1/admin/creators": { items: [
    { id: U(960), user_id: U(961), handle: "mona_style", display_name: "Mona Style", status: "APPLIED", kyc_state: "SUBMITTED", status_reason: null, applied_at: iso(now - 864e5), decided_at: null },
    { id: U(962), user_id: U(963), handle: "cairo_looks", display_name: "Cairo Looks", status: "ACTIVE", kyc_state: "APPROVED", status_reason: "kyc ok", applied_at: iso(now - 9 * 864e5), decided_at: iso(now - 8 * 864e5) },
  ] },
  "/v1/admin/creator-payouts": { items: [
    { id: U(970), creator_id: U(962), amount: m(150000), state: "SCHEDULED", attempt: 0, created_by: U(900), created_at: iso(now - 36e5) },
    { id: U(971), creator_id: U(962), amount: m(90000), state: "APPROVED", attempt: 0, created_by: U(901), created_at: iso(now - 2 * 36e5) },
  ] },
  "/v1/admin/ranking/shadow/summary": { window_hours: 24, runs: 120, personalized_runs: 70, bot_filtered_runs: 6, mean_overlap_permille: 873, top1_same_permille: 612, mean_rank_shift_milli: 1250, shadow_model_versions: ["v2.1"], served: "v1" },
  "/v1/admin/ranking/evaluations": { items: [
    { id: U(980), request_key: "eval-2026-10-11-a", candidate_version: "v2.1", baseline_version: "v1", dataset: "synthetic", seed: 7, requests: 500, k: 10, candidate: { ndcg_bps: 7210, map_bps: 5100 }, baseline: { ndcg_bps: 7050, map_bps: 5000 }, passed: true, reasons: [], created_at: iso(now - 864e5) },
  ] },
};
const routes = { ...adm, ...p3adm, ...sel, ...p3sel, ...design, ...shopper };


// --- Product photo background removal fixtures (additive): list, jobs, decisions, and two tiny sample images.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lr1X9QAAAABJRU5ErkJggg==", "base64");
const mediaLink = (name) => ({ url: `http://127.0.0.1:${PORT}/__media/${name}.png`, expires_at: iso(now + 10 * 6e4) });
const mediaJob = (n, over = {}) => ({
  id: U(n), store_id: U(1), status: "READY", decision: "none", requested_model: "u2netp", model_id: "u2netp", model_version: "1", quality_score: 82,
  quality_reasons: ["white_on_white_risk"], latency_ms: 900, error_code: null, attempts: 1, version: 2, created_at: iso(now - 36e5), updated_at: iso(now - 6e5),
  links: { original: mediaLink("original"), png: mediaLink("cutout"), white_jpg: null, shadow: null }, ...over,
});
const mediaJobs = [
  mediaJob(990),
  mediaJob(991, { status: "NEEDS_REVIEW", quality_score: 55, quality_reasons: ["subject_touches_border", "surprise_code"] }),
  mediaJob(992, { status: "FAILED", quality_score: null, quality_reasons: [], error_code: "storage_error", links: { original: mediaLink("original"), png: null, white_jpg: null, shadow: null } }),
];
const mediaRoutes = {
  [`/v1/seller/stores/${U(1)}/product-media`]: { items: mediaJobs.map((j) => { const s = { ...j }; delete s.links; delete s.latency_ms; delete s.model_version; return s; }) },
  ...Object.fromEntries(mediaJobs.map((j) => [`/v1/seller/stores/${U(1)}/product-media/${j.id}`, j])),
};
Object.assign(routes, mediaRoutes);
const MEDIA_POST = /^\/v1\/seller\/stores\/[0-9a-f-]{36}\/product-media\/([0-9a-f-]{36})\/(accept|use-original|rerun)$/;

// --- Admin web assertion fixture (dashboard foundations T1-a). The DEV_FIXTURES API has no admin grant source, so a
// platform "web" assertion would answer 403 there. This mirrors the real contract for the browser e2e only:
// the assertion returns a server-minted 43-char install token (rotated at every call) and the refresh requires it back
// in X-Admin-Install, else 401. Anything that is not a web assertion or an install-bound refresh goes upstream untouched.
import crypto from "node:crypto";
let webInstallToken = null;
const webSession = () => ({
  access_token: "e2e-web-access", access_expires_at: iso(now + 10 * 6e4), refresh_token: "e2e-web-refresh-" + crypto.randomBytes(8).toString("hex"),
  refresh_expires_at: iso(now + 30 * 864e5), second_factor_required: false, user: { id: U(900) },
});
const readBody = (req) => new Promise((resolve) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => resolve(Buffer.concat(c))); });
const sendJson = (res, status, body) => { res.writeHead(status, { "content-type": status >= 400 ? "application/problem+json" : "application/json" }); res.end(JSON.stringify(body)); };
async function webAuthFixture(req, res, p) {
  if (req.method !== "POST" || (p !== "/v1/auth/passkey/assert" && p !== "/v1/auth/refresh")) return false;
  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch { /* forwarded as is */ }
  const web = p === "/v1/auth/passkey/assert" ? body?.device?.platform === "web" : body?.device_install_id === undefined;
  if (!web) {
    const up = http.request({ host: "127.0.0.1", port: UP, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => { res.writeHead(502); res.end(); });
    up.end(raw);
    return true;
  }
  if (p === "/v1/auth/passkey/assert") {
    webInstallToken = crypto.randomBytes(32).toString("base64url"); // rotated at every login; any client install_id is ignored
    sendJson(res, 200, { ...webSession(), install_token: webInstallToken });
    return true;
  }
  if (webInstallToken === null || req.headers["x-admin-install"] !== webInstallToken) {
    webInstallToken = null; // mismatch revokes the family: the token is gone too
    sendJson(res, 401, { type: "about:blank", title: "Unauthorized", status: 401, code: "invalid_refresh_token" });
    return true;
  }
  sendJson(res, 200, webSession());
  return true;
}

const rid = (u) => u.split("?")[0];
http.createServer(async (req, res) => {
  const p = rid(req.url ?? "/");
  if (await webAuthFixture(req, res, p)) return;
  if (req.method === "GET" && p.startsWith("/__media/")) {
    res.writeHead(200, { "content-type": "image/png" });
    return void res.end(PNG);
  }
  const mp = req.method === "POST" ? MEDIA_POST.exec(p) : null;
  if (mp !== null) {
    const base = mediaJobs.find((j) => j.id === mp[1]);
    if (base === undefined) { res.writeHead(404, { "content-type": "application/problem+json" }); return void res.end(JSON.stringify({ type: "about:blank", title: "Not found", status: 404, code: "not_found" })); }
    req.resume();
    const out = mp[2] === "accept" ? { ...base, decision: "accepted" } : mp[2] === "use-original" ? { ...base, decision: "use_original" } : { ...base, status: "PENDING", attempts: base.attempts + 1, quality_score: null, quality_reasons: [] };
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify(out));
  }
  if (req.method === "GET" && routes[p] !== undefined) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify(routes[p]));
  }
  if (req.method === "GET" && p === `/v1/public/products/${U(812)}`) {
    res.writeHead(410, { "content-type": "application/problem+json" });
    return void res.end(JSON.stringify({ type: "about:blank", title: "Gone", status: 410, code: "gone" }));
  }
  if (req.method === "GET" && /^\/v1\/(public\/)?(products|stores|drops)\/[0-9a-f-]{36}$/i.test(p)) {
    res.writeHead(404, { "content-type": "application/problem+json" });
    return void res.end(JSON.stringify({ type: "about:blank", title: "Not found", status: 404, code: "not_found" }));
  }
  const up = http.request({ host: "127.0.0.1", port: UP, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(up);
}).listen(PORT, "127.0.0.1", () => console.log(`gateway :${PORT} -> :${UP}`));
