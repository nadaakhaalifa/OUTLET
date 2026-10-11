import { describe, expect, it } from "vitest";
import { createSellerApi } from "../api/client";
import { loadDashboard, loadFinance, loadOrders, loadPriceTrust, loadCatalog, type Ctx } from "../loaders";
import { FakeSession } from "../session/fake";
import { fakeTransport, json, UUID_A, UUID_B, UUID_C } from "./fake-transport";

const NOW = Date.parse("2026-10-11T10:00:00Z");
const session = () => new FakeSession({ initial: { accessToken: "tok", refreshToken: "r", accessExpiresAtMs: NOW + 600_000, secondFactorRequired: false } });
const ctx = (routes: Parameters<typeof fakeTransport>[0], locale: "ar" | "en" = "en"): Ctx & { calls: ReturnType<typeof fakeTransport>["calls"] } => {
  const transport = fakeTransport(routes);
  let n = 0;
  return {
    api: createSellerApi({ transport, session: session(), newIdempotencyKey: () => `key-${(n += 1)}` }),
    locale, role: null, nowMs: NOW, calls: transport.calls,
  };
};

const meta = (withinSlo = true) => ({
  store_id: UUID_A, from: "2026-09-11T00:00:00Z", to: "2026-10-12T00:00:00Z",
  freshness: { as_of: "2026-10-11T09:50:00Z", lag_ms: 600_000, slo_ms: 900_000, within_slo: withinSlo }, k_anonymity_min: 50,
});
const m = (minor: string) => ({ amount_minor: minor, currency: "EGP" });
const store = { id: UUID_A, slug: "s", name: { ar: "متجر" }, status: "active", legal_identity: { legal_name: "L" }, kyc_status: "APPROVED" };
const A = "/v1/seller/stores/" + UUID_A + "/analytics";

describe("loadDashboard", () => {
  const base = {
    "GET /v1/seller/store": () => json(store),
    [`GET ${A}/sales`]: () => json({ gmv: m("1250000"), commission: m("125000"), net: m("1125000"), units: 12, orders: 8, aov: m("156250"), repeat_rate_bps: null, repeat_rate_suppressed: true, meta: meta() }),
    [`GET ${A}/funnel`]: () => json({ total: { steps: [{ stage: "view", count: 100, from_previous_bps: null, exceeds_previous: false }], overall_bps: 800 }, meta: meta() }),
    [`GET ${A}/traffic`]: () => json({ store_views: 10, product_views: 20, unique_visitors: 7, by_source: { items: [{ key: "search", events: 60, includes_suppressed: true }], suppressed_cells: 3 }, meta: meta() }),
    [`GET ${A}/geography`]: () => json({ governorates: [], suppressed_governorates: 2, meta: meta() }),
    [`GET ${A}/aging`]: () => json({ alerts: [], meta: meta() }),
  };
  it("maps tiles, hides a suppressed repeat rate as no value (never zero), keeps suppression counts", async () => {
    const s = await loadDashboard(ctx(base));
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready") return;
    const repeat = s.data.tiles.find((x) => x.id === "repeat");
    expect(repeat?.value).toBeNull();
    expect(s.data.tiles.find((x) => x.id === "gmv")?.value).toBe("EGP 12,500");
    expect(s.data.traffic?.suppressed).toBe(3);
    expect(s.data.traffic?.rows[0]?.includesSuppressed).toBe(true);
    expect(s.data.geography?.suppressed).toBe(2);
    expect(s.data.freshness.level).toBe("within");
    expect(s.data.kMin).toBe(50);
  });
  it("flags stale freshness", async () => {
    const s = await loadDashboard(ctx({ ...base, [`GET ${A}/sales`]: () => json({ gmv: m("1"), commission: m("0"), net: m("1"), units: 1, orders: 1, aov: m("1"), repeat_rate_bps: null, repeat_rate_suppressed: false, meta: meta(false) }) }));
    expect(s.kind === "ready" && s.data.freshness.level).toBe("stale");
  });
  it("is empty (not zeros) when there was no activity", async () => {
    const s = await loadDashboard(ctx({ ...base, [`GET ${A}/sales`]: () => json({ gmv: m("0"), commission: m("0"), net: m("0"), units: 0, orders: 0, aov: null, repeat_rate_bps: null, repeat_rate_suppressed: false, meta: meta() }) }));
    expect(s.kind).toBe("empty");
  });
  it("degrades a failed secondary report to null without failing the page", async () => {
    const s = await loadDashboard(ctx({ ...base, [`GET ${A}/geography`]: () => json({ title: "x" }, 500) }));
    expect(s.kind === "ready" && s.data.geography).toBeNull();
  });
  it("is not_configured without an api and offline when the network is down", async () => {
    expect((await loadDashboard({ api: null, locale: "ar", role: null, nowMs: NOW })).kind).toBe("not_configured");
    expect((await loadDashboard(ctx({ "GET /v1/seller/store": () => "network" }))).kind).toBe("offline");
  });
  it("maps 403 and a malformed body to distinct error states", async () => {
    const f = await loadDashboard(ctx({ "GET /v1/seller/store": () => json({ title: "no" }, 403) }));
    expect(f).toMatchObject({ kind: "error", messageKey: "state.forbidden", retryable: false });
    const c = await loadDashboard(ctx({ "GET /v1/seller/store": () => json({ nope: true }) }));
    expect(c).toMatchObject({ kind: "error", messageKey: "state.contract" });
  });
});

describe("loadOrders", () => {
  const order = (over: Record<string, unknown> = {}) => ({
    id: UUID_B, status: "PAID",
    lines: [{ id: UUID_C, sku_id: UUID_C, title: { ar: "فستان", en: "Dress" }, size_label: "M", qty: 2, unit_price: { amount: "50000", currency: "EGP" } }],
    subtotal: { amount: "100000", currency: "EGP" }, shipping: { amount: "0", currency: "EGP" },
    net_to_seller: { amount: "90000", currency: "EGP" },
    buyer: { governorate_code: "CAI" }, accept_by: "2026-10-12T09:00:00Z", payment_type: "cod", created_at: "2026-10-11T09:00:00Z", ...over,
  });
  it("gives accept/reject and a deadline for a paid order, none for a shipped one", async () => {
    const s = await loadOrders(ctx({ "GET /v1/seller/orders": () => json({ items: [order(), order({ id: UUID_A, status: "SHIPPED" })], page: { has_more: false } }) }));
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready") return;
    expect(s.data.rows[0]?.actions).toEqual(["accept", "reject"]);
    expect(s.data.rows[0]?.deadlineIso).toBe("2026-10-12T09:00:00Z");
    expect(s.data.rows[0]?.paymentKey).toBe("orders.payment.cod");
    expect(s.data.rows[1]?.actions).toEqual([]);
    expect(s.data.rows[1]?.deadlineIso).toBeNull();
    expect(s.serverNowMs).toBe(Date.parse("2026-10-11T10:00:00Z"));
  });
  it("is empty for no orders and exposes a cursor for the next page", async () => {
    const e = await loadOrders(ctx({ "GET /v1/seller/orders": () => json({ items: [], page: { has_more: false } }) }));
    expect(e.kind).toBe("empty");
    const p = await loadOrders(ctx({ "GET /v1/seller/orders": () => json({ items: [order()], page: { has_more: true, next_cursor: "abc" } }) }));
    expect(p.kind === "ready" && p.data.nextCursor).toBe("abc");
  });
});

describe("loadFinance", () => {
  it("renders bigint piastres exactly and hides a zero negative carry", async () => {
    const s = await loadFinance(ctx({
      "GET /v1/seller/balance": () => json({ available: { amount: "123456789012345678", currency: "EGP" }, pending_release: { amount: "100", currency: "EGP" }, held: { amount: "0", currency: "EGP" }, negative_carry: { amount: "0", currency: "EGP" }, as_of: "2026-10-11T09:00:00Z" }),
      "GET /v1/seller/payouts": () => json({ items: [], page: { has_more: false } }),
      "GET /v1/seller/statements": () => json({ items: [], page: { has_more: false } }),
      "GET /v1/seller/invoices": () => json({ items: [{ id: UUID_A, kind: "commission_einvoice", status: "accepted", amount: { amount: "11400", currency: "EGP" }, vat: { amount: "1400", currency: "EGP" }, eta_uuid: "ETA-1", created_at: "2026-10-01T00:00:00Z" }], page: { has_more: false } }),
    }));
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready") return;
    expect(s.data.balance.available).toContain("1,234,567,890,123,456.78");
    expect(s.data.balance.negativeCarry).toBeNull();
    expect(s.data.invoices[0]?.etaUuid).toBe("ETA-1");
  });
});

describe("loadPriceTrust / loadCatalog", () => {
  it("shows the cure text in the active locale and never invents a percent off", async () => {
    const s = await loadPriceTrust(ctx({
      "GET /v1/seller/price-trust": () => json({ score: 71.6, violations_in_window: 1, window_days: 90, ladder_state: "badge_removed", active_actions: [{ id: UUID_A, action: "badge_removed", applied_at: "2026-10-01T00:00:00Z", cure: { ar: "صحح السعر", en: "Fix price" } }] }),
      "GET /v1/seller/price-claims": () => json({ items: [], page: { has_more: false } }),
    }, "ar"));
    expect(s.kind === "ready" && s.data.actions[0]?.cure).toBe("صحح السعر");
    expect(s.kind === "ready" && s.data.ladderKey).toBe("trust.ladder.badge_removed");
  });
  it("catalog row shows a price range and plain-price label when there is no claim", async () => {
    const sku = (id: string, p: string) => ({ id, size_label: "M", price: { amount: p, currency: "EGP" }, on_hand: 3 });
    const s = await loadCatalog(ctx({
      "GET /v1/seller/products": () => json({ items: [{ id: UUID_A, status: "active", title: { ar: "قميص" }, category_id: UUID_B, condition: "new_with_tags", skus: [sku(UUID_B, "30000"), sku(UUID_C, "45000")], updated_at: "2026-10-01T00:00:00Z" }], page: { has_more: false } }),
    }));
    expect(s.kind === "ready" && s.data.rows[0]?.price).toBe("EGP 300 - EGP 450");
    expect(s.kind === "ready" && s.data.rows[0]?.claimKey).toBe("catalog.claim.none");
    expect(s.kind === "ready" && s.data.rows[0]?.stock).toBe("6");
  });
});
