import type { DashboardResponse, TileKey } from "../src/lib/dashboard";
import type { z } from "zod";
import type { KycCaseView, ReconItem } from "../src/lib/schemas";

export const CASE_ID = "c0de0000-0000-4000-8000-000000000001";
export const DOC_ID = "d0c00000-0000-4000-8000-000000000001";

export const kycCase: KycCaseView = {
  case: {
    id: CASE_ID, seller_id: "5e11e000-0000-4000-8000-000000000001", kind: "seller", status: "SUBMITTED", version: 1,
    documents: [{ id: DOC_ID, doc_type: "commercial_register", media_id: "3ed1a000-0000-4000-8000-000000000001", verified: false, created_at: "2026-11-01T10:00:00Z" }],
    required_documents: ["commercial_register", "tax_card"],
    signatory: { full_name_masked: "م*** ع***", national_id_last4: "4821" },
  },
  seller_legal: { legal_name_ar: "متجر النيل", commercial_register_no: "CR-884201", tax_card_no: "TC-552019", governorate_name_ar: "القاهرة" },
  checks: [{ check_type: "register_lookup", result: "pass", checked_at: "2026-11-01T10:05:00Z" }],
};

export const reconItem = (over: Partial<z.infer<typeof ReconItem>>): z.infer<typeof ReconItem> => ({
  id: "a1000000-0000-4000-8000-000000000001", run_id: "7e100000-0000-4000-8000-000000000001", source_ref_type: "psp_settlement_line", expected: { amount_minor: "250000", currency: "EGP" }, actual: null,
  status: "UNMATCHED", first_seen_at: "2026-11-01T10:00:00Z", age_days: 1, ...over,
});

// ---- Dashboard fixtures. TEST-ONLY: these numbers are invented for assertions and must never be shown as real anywhere else. ----

export const DASH_NOW = new Date("2026-11-10T09:00:00Z");
export const DASH_AS_OF = "2026-11-10T08:59:30Z";
const egp = (minor: string) => ({ amount_minor: minor, currency: "EGP" });
const okTile = <K extends string, D>(key: K, data: D) => ({ key, status: "ok" as const, as_of: DASH_AS_OF, data });
const day = (offset: number) => new Date(Date.UTC(2026, 10, 10) + offset * 86_400_000).toISOString().slice(0, 10);
const days = (n: number) => Array.from({ length: n }, (_, i) => day(i - n + 1));

export function dashboardFixture(over: Partial<Record<TileKey, unknown>> = {}, range: "7d" | "30d" | "90d" = "30d"): DashboardResponse {
  const n = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const base = {
    orders_today: okTile("orders_today", { count: 42, series_14d: days(14).map((d, i) => ({ day: d, value: i + 1 })) }),
    gmv_today: okTile("gmv_today", { gmv: egp("12345600"), refunded: egp("50000"), gmv_7d: egp("98765400") }),
    sales_series: okTile("sales_series", { orders: days(n).map((d, i) => ({ day: d, value: i + 1 })), gmv: days(n).map((d, i) => ({ day: d, value: egp(String((i + 1) * 100000)) })), total_orders: 777, total_gmv: egp("55500000") }),
    orders_by_step: okTile("orders_by_step", { paid_awaiting_accept: 5, accepted: 4, packed: 3, in_transit: 2, delivery_failed: 1 }),
    top_stores: okTile("top_stores", { items: [{ store_id: "5702e000-0000-4000-8000-000000000001", name_ar: "متجر النيل", name_en: "Nile Store", orders: 12, gmv: egp("900000") }], other: { stores: 3, orders: 7, gmv: egp("300000") } }),
    verified_discount_share: okTile("verified_discount_share", { verified: 30, live_skus: 120 }),
    seller_sla_breaches: okTile("seller_sla_breaches", { late_accept: 2, late_dispatch: 1, oldest_at: "2026-11-09T08:00:00Z" }),
    cod_awaiting_confirmation: okTile("cod_awaiting_confirmation", { count: 6, oldest_at: null }),
    returns_pipeline: okTile("returns_pipeline", { requested: 3, in_transit: 2, awaiting_inspection: 1, inspection_overdue: 0 }),
    disputes_open: okTile("disputes_open", { open: 4, past_sla: 1, oldest_at: null }),
    refunds_waiting: okTile("refunds_waiting", { count: 8, amount: egp("450000"), manual_review: 2, failed: 1, oldest_at: null }),
    refunds_overdue: okTile("refunds_overdue", { count: 0, amount: egp("0"), oldest_due_at: null }),
    payouts: okTile("payouts", { due_count: 9, due_net: egp("7000000"), on_hold_count: 0, on_hold_net: egp("0"), failed: 0, open_holds: 0 }),
    recon_unmatched: okTile("recon_unmatched", { open: 2, escalated: 0, aged_over_3d: 0, oldest_at: null }),
    cod_unremitted: { key: "cod_unremitted", status: "unavailable", reason: "not_connected" },
    ledger_integrity: { key: "ledger_integrity", status: "unavailable", reason: "not_connected" },
    kyc_queue: okTile("kyc_queue", { submitted: 3, needs_info: 1, oldest_at: "2026-11-08T08:00:00Z" }),
    stores_moderation: okTile("stores_moderation", { pending_review: 0, suspended: 1 }),
    price_enforcement: okTile("price_enforcement", { active: 5, pending_review: 0, suspensions_awaiting_review: 0 }),
    listings_by_status: okTile("listings_by_status", { published: 100, in_review: 5, paused: 3, blocked: 1 }),
    breaches_open: okTile("breaches_open", { open: 0, next_pdpc_deadline_at: null, next_subjects_deadline_at: null }),
    dsar_queue: okTile("dsar_queue", { open: 3, due_7d: 1, overdue: 0 }),
    attention_open: okTile("attention_open", { open: 2, acked: 1, by_kind: { "refund.attention": 2 }, oldest_at: null }),
    approvals_pending: okTile("approvals_pending", { for_me: 1, soonest_expires_at: "2026-11-11T09:00:00Z" }),
    elevations_active: okTile("elevations_active", { active: 1, pending: 0, scope: "market" }),
    kill_switches: okTile("kill_switches", { engaged_money: [], engaged_ui: [] }),
  } satisfies Record<TileKey, unknown>;
  const t = { ...base, ...over } as Record<TileKey, unknown>;
  const pick = (keys: readonly TileKey[]) => Object.fromEntries(keys.map((k) => [k, t[k]]));
  return {
    market_id: "eg", range, timezone: "Africa/Cairo", today: "2026-11-10", generated_at: DASH_AS_OF,
    sections: {
      today: pick(["orders_today", "gmv_today"]),
      sales: pick(["sales_series", "orders_by_step", "top_stores", "verified_discount_share"]),
      orders: pick(["seller_sla_breaches", "cod_awaiting_confirmation", "returns_pipeline", "disputes_open"]),
      money: pick(["refunds_waiting", "refunds_overdue", "payouts", "recon_unmatched", "cod_unremitted", "ledger_integrity"]),
      trust: pick(["kyc_queue", "stores_moderation", "price_enforcement", "listings_by_status"]),
      privacy: pick(["breaches_open", "dsar_queue"]),
      platform: pick(["attention_open", "approvals_pending", "elevations_active", "kill_switches"]),
    },
  } as unknown as DashboardResponse;
}

export const forbidden = (key: string) => ({ key, status: "forbidden" as const });
export const unavailable = (key: string, reason: "not_connected" | "read_failed" | "stale") => ({ key, status: "unavailable" as const, reason });

/** Every finance-only tile forbidden, as for an ops-only role. */
export const FINANCE_TILES = ["gmv_today", "refunds_waiting", "refunds_overdue", "payouts", "recon_unmatched", "cod_unremitted", "ledger_integrity", "top_stores"] as const satisfies readonly TileKey[];

export const ATTENTION_ID_A = "a7700000-0000-4000-8000-000000000001";
export const ATTENTION_ID_B = "a7700000-0000-4000-8000-000000000002";
export const attentionItems = [
  { id: ATTENTION_ID_A, kind: "refund.attention", ref_type: "refund", ref_id: "r-1001", status: "OPEN", created_at: "2026-11-10T07:00:00Z" },
  { id: ATTENTION_ID_B, kind: "shipment.cancel_attention", ref_type: "shipment", ref_id: "s-2002", status: "ACKED", created_at: "2026-11-09T07:00:00Z", acked_at: "2026-11-09T08:00:00Z" },
];
