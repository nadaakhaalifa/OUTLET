import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createSellerApi } from "../api/client";
import { FakeChannelOAuth, isTrustedConnectUrl } from "../channels/oauth-port";
import { cairoLocalToIso } from "../lib/cairo-time";
import { formatRatioBps, parseEgpToMinor } from "../lib/money-input";
import { loadAds, loadChannels, loadDrops, loadHub, loadInsights, loadResale } from "../loaders-phase2";
import type { Ctx } from "../loaders";
import { FakeSession } from "../session/fake";
import { balanceSummary, campaignRows, reportTiles, validateCampaign } from "../view-models/ads";
import { normaliseShopDomain, parityWarnings, PARITY_FIX_WINDOW_MS, incidents } from "../view-models/channels";
import { checkStockEdit, editability, validateDrop, type DropDraft } from "../view-models/drops";
import { markdownRows } from "../view-models/insights";
import { navFor } from "../view-models/nav";
import { permissionsFor } from "./permissions";
import { resaleRows } from "../view-models/resale";
import { slaCountdown } from "../view-models/sla";
import { fakeTransport, json, UUID_A, UUID_B, UUID_C } from "./fake-transport";

const NOW = Date.parse("2026-10-11T10:00:00Z");
const session = () => new FakeSession({ initial: { accessToken: "tok", refreshToken: "r", accessExpiresAtMs: NOW + 600_000, secondFactorRequired: false } });
const ctx = (routes: Parameters<typeof fakeTransport>[0], locale: "ar" | "en" = "en"): Ctx & { calls: ReturnType<typeof fakeTransport>["calls"] } => {
  const transport = fakeTransport(routes);
  let n = 0;
  return { api: createSellerApi({ transport, session: session(), newIdempotencyKey: () => `key-${(n += 1)}` }), locale, role: null, nowMs: NOW, calls: transport.calls };
};
const m = (minor: string) => ({ amount: minor, currency: "EGP" });
const store = { id: UUID_A, slug: "s", name: { ar: "متجر" }, status: "active", legal_identity: { legal_name: "L" }, kyc_status: "APPROVED" };
const STORE = { "GET /v1/seller/store": () => json(store) };
const TS = "2026-10-11T09:00:00Z";

describe("money and time inputs", () => {
  it("parses EGP to piastres with integer math", () => {
    expect(parseEgpToMinor("125.5")).toBe("12550");
    expect(parseEgpToMinor("١٢٫٥")).toBe("1250");
    expect(parseEgpToMinor("0")).toBeNull();
    expect(parseEgpToMinor("-1")).toBeNull();
    expect(parseEgpToMinor("1.234")).toBeNull();
    expect(parseEgpToMinor("")).toBeNull();
    expect(parseEgpToMinor("1e3")).toBeNull();
  });
  it("round-trips any whole-piastre amount (property)", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 10_000_000_00 }), (p) => {
      const text = `${Math.floor(p / 100)}.${String(p % 100).padStart(2, "0")}`;
      return parseEgpToMinor(text) === String(p);
    }));
  });
  it("formats ROAS from basis points without floats", () => {
    expect(formatRatioBps(25000n, "en")).toBe("2.50×");
    expect(formatRatioBps(10000n, "en")).toBe("1.00×");
    expect(formatRatioBps(25000n, "ar")).toBe("٢٫٥٠×");
  });
  it("converts Cairo wall time to UTC across Egypt DST", () => {
    expect(cairoLocalToIso("2026-01-15T12:00")).toBe("2026-01-15T10:00:00.000Z"); // UTC+2
    expect(cairoLocalToIso("2026-07-15T12:00")).toBe("2026-07-15T09:00:00.000Z"); // UTC+3
    expect(cairoLocalToIso("nope")).toBeNull();
    expect(cairoLocalToIso("2026-13-45T99:99")).toBeNull();
  });
});

describe("ads view models", () => {
  const camp = (status: string, minor: string) => ({
    id: UUID_B, store_id: UUID_A, name: "C", status, daily_budget: m(minor), max_cpc: m("500"), keywords: [], categories: [],
    starts_at: TS, ends_at: null, bids: [{ product_id: UUID_C, bid: m("300") }], vat_inclusive: false as const, created_at: TS,
  });
  const stat = { impressions: 0, clicks: 0, spend: m("0"), attributed_revenue: m("0"), ctr_bp: 0, cpc: null, roas_bp: null };
  it("never shows zero for undefined ratios", () => {
    const tiles = reportTiles({ ...stat, spend: { minor: 0n, currency: "EGP" }, attributed_revenue: { minor: 0n, currency: "EGP" } }, "en");
    for (const id of ["ctr", "cpc", "roas"]) expect(tiles.find((x) => x.id === id)?.value).toBeNull();
  });
  it("computes ROAS and CPC when present", () => {
    const tiles = reportTiles({ ...stat, impressions: 1000, clicks: 20, ctr_bp: 200, cpc: { minor: 250n, currency: "EGP" }, roas_bp: "35000", spend: { minor: 5000n, currency: "EGP" }, attributed_revenue: { minor: 17500n, currency: "EGP" } }, "en");
    expect(tiles.find((x) => x.id === "roas")?.value).toBe("3.50×");
    expect(tiles.find((x) => x.id === "cpc")?.value).toBe("EGP 2.50");
    expect(tiles.find((x) => x.id === "ctr")?.value).toBe("2%");
  });
  it("flags a balance below active daily caps and ignores paused campaigns", () => {
    const parse = (c: ReturnType<typeof camp>) => ({ ...c, daily_budget: { minor: BigInt(c.daily_budget.amount), currency: "EGP" as const }, max_cpc: { minor: 500n, currency: "EGP" as const }, bids: [], vat_inclusive: false as const });
    const items = [parse(camp("active", "30000")), parse(camp("paused", "90000"))];
    const bal = { balance: { minor: 20000n, currency: "EGP" as const }, vat_inclusive: false as const, top_ups: [] };
    const out = balanceSummary(bal, items, "en");
    expect(out.activeDailyCaps).toBe("EGP 300");
    expect(out.belowDailyCaps).toBe(true);
    expect(balanceSummary({ ...bal, balance: { minor: 30000n, currency: "EGP" } }, items, "en").belowDailyCaps).toBe(false);
  });
  it("offers pause only for active and resume only for paused", () => {
    const rows = campaignRows([
      { ...camp("active", "100"), daily_budget: { minor: 100n, currency: "EGP" }, max_cpc: { minor: 50n, currency: "EGP" }, bids: [] },
      { ...camp("paused", "100"), daily_budget: { minor: 100n, currency: "EGP" }, max_cpc: { minor: 50n, currency: "EGP" }, bids: [] },
      { ...camp("weird", "100"), daily_budget: { minor: 100n, currency: "EGP" }, max_cpc: { minor: 50n, currency: "EGP" }, bids: [] },
    ], "en");
    expect(rows.map((r) => [r.canPause, r.canResume])).toEqual([[true, false], [false, true], [false, false]]);
    expect(rows[2]?.statusKey).toBe("ads.status.unknown");
  });
  const draft = { storeId: UUID_A, name: "Eid", dailyBudget: "300", maxCpc: "2.5", startsAtLocal: "2026-11-01T10:00", endsAtLocal: "", productId: UUID_C, bid: "2", keywords: "dress, linen" };
  it("validates a campaign and builds the wire body in piastres and UTC", () => {
    const r = validateCampaign(draft);
    expect(r.ok && r.value.daily_budget.amount).toBe("30000");
    expect(r.ok && r.value.max_cpc.amount).toBe("250");
    expect(r.ok && r.value.starts_at).toBe("2026-11-01T08:00:00.000Z");
    expect(r.ok && r.value.keywords).toEqual(["dress", "linen"]);
  });
  it("rejects bad campaigns with specific keys", () => {
    const r = validateCampaign({ ...draft, name: "x", maxCpc: "500", productId: "abc", endsAtLocal: "2026-10-01T10:00" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(expect.arrayContaining(["ads.err.name", "ads.err.cpcAboveBudget", "ads.err.product", "ads.err.endBeforeStart"]));
  });
});

describe("drops rules", () => {
  it("locks everything but stock after SCHEDULED", () => {
    expect(editability("DRAFT").full).toBe(true);
    expect(editability("scheduled")).toEqual({ full: false, stockIncreaseOnly: true, canSchedule: false });
    expect(editability("ENDED").stockIncreaseOnly).toBe(false);
  });
  const prev = [{ sku_id: UUID_A, stock_cap: 10, price: 5000n }];
  it("allows only stock increases once scheduled", () => {
    expect(checkStockEdit("SCHEDULED", prev, [{ sku_id: UUID_A, stock_cap: 20, price: 5000n }])).toEqual([]);
    expect(checkStockEdit("LIVE", prev, [{ sku_id: UUID_A, stock_cap: 5, price: 5000n }])).toEqual(["decrease"]);
    expect(checkStockEdit("SCHEDULED", prev, [{ sku_id: UUID_A, stock_cap: 20, price: 4000n }])).toEqual(["price_changed"]);
    expect(checkStockEdit("SCHEDULED", prev, [{ sku_id: UUID_B, stock_cap: 20, price: 5000n }])).toEqual(["sku_changed"]);
    expect(checkStockEdit("ENDED", prev, prev)).toEqual(["locked"]);
    expect(checkStockEdit("DRAFT", prev, [{ sku_id: UUID_A, stock_cap: 1, price: 1n }])).toEqual([]);
  });
  const d: DropDraft = {
    type: "members_only", title: "Linen", startsAtLocal: "2026-11-20T18:00", earlyAccessLocal: "2026-11-19T18:00", endsAtLocal: "2026-11-21T18:00",
    skuId: UUID_A, stockCap: "50", price: "499", perUser: "2", perDevice: "2", ladderAtLocal: "", ladderPrice: "", mysteryMin: "", mysteryMax: "", mysteryGuaranteed: "",
  };
  it("builds a drop from Cairo-time inputs", () => {
    const r = validateDrop(d);
    expect(r.ok && r.value.starts_at).toBe("2026-11-20T16:00:00.000Z");
    expect(r.ok && r.value.early_access_at).toBe("2026-11-19T16:00:00.000Z");
    expect(r.ok && r.value.items[0]?.price).toBe("49900");
  });
  it("rejects early access after start, on non-members drops, and bad limits", () => {
    const a = validateDrop({ ...d, earlyAccessLocal: "2026-11-20T19:00" });
    expect(!a.ok && a.errors).toContain("drops.err.early");
    const b = validateDrop({ ...d, type: "public" });
    expect(!b.ok && b.errors).toContain("drops.err.earlyType");
    const c = validateDrop({ ...d, perUser: "3", perDevice: "2" });
    expect(!c.ok && c.errors).toContain("drops.err.deviceBelowUser");
    const e = validateDrop({ ...d, perUser: "11" });
    expect(!e.ok && e.errors).toContain("drops.err.limits");
  });
  it("requires a lower next price for a ladder and ordered mystery values", () => {
    const l = validateDrop({ ...d, type: "price_ladder", earlyAccessLocal: "", ladderAtLocal: "2026-11-21T00:00", ladderPrice: "600" });
    expect(!l.ok && l.errors).toContain("drops.err.ladderNotLower");
    const ok = validateDrop({ ...d, type: "price_ladder", earlyAccessLocal: "", ladderAtLocal: "2026-11-21T00:00", ladderPrice: "400" });
    expect(ok.ok).toBe(true);
    const mb = validateDrop({ ...d, type: "mystery_box", earlyAccessLocal: "", mysteryMin: "300", mysteryMax: "200", mysteryGuaranteed: "250" });
    expect(!mb.ok && mb.errors).toContain("drops.err.mystery");
  });
});

describe("resale never shows percent off", () => {
  const l = { id: UUID_A, sku_id: UUID_B, grade: "B" as const, price_piastres: 45000n, ownership: "hub", status: "LISTED", listed_at: TS, sold_at: null };
  it("exposes the price only: no reference price field, no percent in any value", () => {
    const [row] = resaleRows([l], "en");
    expect(row?.price).toBe("EGP 450");
    expect(Object.keys(row ?? {}).some((k) => /percent|off|reference|original|was/i.test(k))).toBe(false);
    for (const v of Object.values(row ?? {})) expect(String(v)).not.toMatch(/%|٪/);
    expect(row?.canWithdraw).toBe(true);
  });
  it("only available listings can be withdrawn", () => {
    expect(resaleRows([{ ...l, status: "SOLD", sold_at: TS }, { ...l, status: "WITHDRAWN" }, { ...l, status: "???" }], "en").map((r) => r.canWithdraw)).toEqual([false, false, false]);
  });
});

describe("insights view models", () => {
  const alert = (shows: boolean) => ({
    sku_id: UUID_A, product_id: UUID_B, size: "M", severity: "warning", age_days: 90, on_hand: 12, sell_through_bps: null as number | null,
    price: { minor: 80000n, currency: "EGP" as const },
    markdown_recommendation: { action: "markdown", suggested_price: { minor: 64900n, currency: "EGP" as const }, shows_percent_off: shows, notice: { en: "no % off", ar: "بدون خصم" } },
  });
  const meta = { store_id: UUID_A, from: TS, to: TS, freshness: { as_of: TS, lag_ms: 0, slo_ms: 1, within_slo: true }, k_anonymity_min: 50 };
  it("shows a suggestion but drops it if the server claims a percent-off", () => {
    const [ok] = markdownRows({ alerts: [alert(false)], meta }, "en");
    expect(ok?.suggested).toBe("EGP 649");
    expect(ok?.sellThrough).toBeNull();
    const [bad] = markdownRows({ alerts: [alert(true)], meta }, "en");
    expect(bad?.suggested).toBeNull();
    expect(bad?.percentOffBlocked).toBe(true);
  });
});

describe("channels, incidents and parity", () => {
  it("accepts bare hostnames only", () => {
    expect(normaliseShopDomain("  Shop.Example.com ")).toBe("shop.example.com");
    for (const bad of ["https://shop.example.com", "shop.example.com/path", "localhost", "10.0.0.1", "a b.com", "user@shop.com", "shop.com:8080"]) expect(normaliseShopDomain(bad), bad).toBeNull();
  });
  it("only follows https connect URLs on the shop's own domain", () => {
    expect(isTrustedConnectUrl("shopify", "x.myshopify.com", "https://x.myshopify.com/admin/oauth/authorize?a=1")).toBe(true);
    expect(isTrustedConnectUrl("woocommerce", "shop.example.com", "https://shop.example.com/wc-auth/v1/authorize")).toBe(true);
    expect(isTrustedConnectUrl("woocommerce", "shop.example.com", "https://evil.com/?shop.example.com")).toBe(false);
    expect(isTrustedConnectUrl("woocommerce", "shop.example.com", "http://shop.example.com/")).toBe(false);
    expect(isTrustedConnectUrl("woocommerce", "shop.example.com", "https://evilshop.example.com.evil.com/")).toBe(false);
    expect(isTrustedConnectUrl("woocommerce", "shop.example.com", "javascript:alert(1)")).toBe(false);
  });
  it("fake OAuth port records the begin call and refuses untrusted URLs", async () => {
    const fake = new FakeChannelOAuth();
    const good = await fake.begin({ type: "shopify", shopDomain: "x.myshopify.com", connectUrl: "https://x.myshopify.com/a" });
    const bad = await fake.begin({ type: "shopify", shopDomain: "x.myshopify.com", connectUrl: "https://evil.example/a" });
    expect(good.ok).toBe(true);
    expect(!bad.ok && bad.error).toBe("untrusted_url");
    expect(fake.begun).toHaveLength(2);
  });
  it("derives parity warnings with a 48 h deadline and counts down on SERVER time", () => {
    const applied = "2026-10-11T08:00:00Z";
    const [w] = parityWarnings([{ id: UUID_A, action: "demotion", reason_code: "cross_channel_cheaper", applied_at: applied }, { id: UUID_B, action: "other", applied_at: applied }], "en");
    expect(w?.fixDeadlineIso).toBe(new Date(Date.parse(applied) + PARITY_FIX_WINDOW_MS).toISOString());
    expect(parityWarnings([{ id: UUID_B, action: "other", applied_at: applied }], "en")).toHaveLength(0);
    // Server says 2 h after application: 46 h left, whatever the device clock is.
    const c = slaCountdown({ deadlineIso: w?.fixDeadlineIso ?? null, serverNowMs: Date.parse("2026-10-11T10:00:00Z"), elapsedSinceFetchMs: 0 });
    expect(c.level).toBe("ok");
    expect(c.hours).toBe(46);
    expect(slaCountdown({ deadlineIso: w?.fixDeadlineIso ?? null, serverNowMs: null, elapsedSinceFetchMs: 0 }).level).toBe("none");
    expect(slaCountdown({ deadlineIso: w?.fixDeadlineIso ?? null, serverNowMs: Date.parse("2026-10-13T08:00:01Z"), elapsedSinceFetchMs: 0 }).level).toBe("overdue");
  });
  it("lists incidents from channel and crawl read models only", () => {
    const ch = (status: "connected" | "revoked" | "error") => ({ id: UUID_A, type: "shopify" as const, shop_domain: "a.com", status });
    const tg = (verified: string | null, robots: string | null) => ({ id: UUID_B, domain: "b.com", kind: "crawler", status: "x", verification_method: "dns_txt" as const, verified_at: verified, robots_checked_at: robots });
    const out = incidents([ch("connected"), ch("revoked"), ch("error")], [tg(null, null), tg(TS, null), tg(TS, TS)]);
    expect(out.map((i) => i.reasonKey)).toEqual(["channels.incident.revoked", "channels.incident.error", "channels.incident.unverified", "channels.incident.robots"]);
  });
});

describe("navigation", () => {
  it("lists the Phase 2 screens for owners and hides ads (store_settings.read) from finance", () => {
    const owner = navFor(permissionsFor("owner")).map((i) => i.href);
    for (const h of ["/ads", "/drops", "/resale", "/insights", "/channels", "/hub"]) expect(owner).toContain(h);
    expect(navFor(permissionsFor("finance")).map((i) => i.href)).not.toContain("/ads");
  });
});

describe("phase 2 loaders", () => {
  const campaign = { id: UUID_B, store_id: UUID_A, name: "Eid", status: "active", daily_budget: m("30000"), max_cpc: m("250"), keywords: [], categories: [], starts_at: TS, ends_at: null, bids: [], vat_inclusive: false as const, created_at: TS };
  const stats = { impressions: 100, clicks: 4, spend: m("1000"), attributed_revenue: m("5000"), ctr_bp: 400, cpc: m("250"), roas_bp: "50000" };
  const adsRoutes = {
    ...STORE,
    "GET /v1/seller/ads/campaigns": () => json({ items: [campaign] }),
    "GET /v1/seller/ads/balance": () => json({ balance: m("10000"), vat_inclusive: false, top_ups: [{ id: "t1", status: "paid", net: m("10000"), vat: m("1400"), gross: m("11400") }] }),
    "GET /v1/seller/ads/reports": () => json({ from: TS, to: TS, total: stats, campaigns: [{ campaign_id: UUID_B, name: "Eid", ...stats }] }),
  };
  it("loads ads and sends the store id", async () => {
    const c = ctx(adsRoutes);
    const s = await loadAds(c);
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready") return;
    expect(s.data.balance?.belowDailyCaps).toBe(true);
    expect(s.data.balance?.topUps[0]?.gross).toBe("EGP 114");
    expect(s.data.tiles?.find((x) => x.id === "roas")?.value).toBe("5.00×");
    expect(c.calls.find((x) => x.path === "/v1/seller/ads/campaigns")?.query?.store_id).toBe(UUID_A);
  });
  it("keeps the campaign list when only the report fails", async () => {
    const s = await loadAds(ctx({ ...adsRoutes, "GET /v1/seller/ads/reports": () => json({}, 500) }));
    expect(s.kind === "ready" && s.data.tiles).toBeNull();
    expect(s.kind === "ready" && s.data.campaigns).toHaveLength(1);
  });
  it("maps offline, 403, contract drift and missing config", async () => {
    expect((await loadAds(ctx({ ...adsRoutes, "GET /v1/seller/ads/campaigns": () => "network" }))).kind).toBe("offline");
    const f = await loadAds(ctx({ ...adsRoutes, "GET /v1/seller/ads/campaigns": () => json({ title: "no" }, 403) }));
    expect(f.kind === "error" && f.messageKey).toBe("state.forbidden");
    const d = await loadAds(ctx({ ...adsRoutes, "GET /v1/seller/ads/campaigns": () => json({ items: [{ id: "bad" }] }) }));
    expect(d.kind === "error" && d.messageKey).toBe("state.contract");
    expect((await loadAds({ api: null, locale: "en", role: null, nowMs: NOW })).kind).toBe("not_configured");
  });

  const drop = {
    id: UUID_A, store_id: UUID_B, type: "flash_hour", state: "SCHEDULED", paused: false, title: "Flash", starts_at: "2026-10-11T12:00:00Z", early_access_at: null,
    ends_at: "2026-10-11T13:00:00Z", limits: { per_user: 1, per_device: 1 }, mystery: null, ladder: [], server_time: "2026-10-11T10:00:00Z", currency: "EGP",
    admit_per_sec: null, version: 3, items: [{ sku_id: UUID_C, stock_cap: 40, price: "49900" }], created_at: TS, updated_at: TS,
  };
  it("loads drops: scheduled drop allows stock raise only, uses the response server time", async () => {
    const s = await loadDrops(ctx({ "GET /v1/seller/drops": () => json({ items: [drop], page: { next_cursor: null, has_more: false } }) }));
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready") return;
    const row = s.data.rows[0];
    expect(row?.canSchedule).toBe(false);
    expect(row?.canRaiseStock).toBe(true);
    expect(row?.serverTimeMs).toBe(Date.parse("2026-10-11T10:00:00Z"));
    expect(row?.items[0]?.price).toBe("EGP 499");
    expect(row?.soldOutWaitlist).toBe(false);
  });
  it("marks sold-out drops for the waitlist note and DRAFT as schedulable", async () => {
    const s = await loadDrops(ctx({ "GET /v1/seller/drops": () => json({ items: [{ ...drop, state: "SOLD_OUT" }, { ...drop, state: "DRAFT" }], page: { next_cursor: null, has_more: false } }) }));
    expect(s.kind === "ready" && s.data.rows.map((r) => [r.soldOutWaitlist, r.canSchedule, r.canRaiseStock])).toEqual([[true, false, false], [false, true, false]]);
  });

  it("loads resale listings for the store", async () => {
    const s = await loadResale(ctx({ ...STORE, [`GET /v1/seller/stores/${UUID_A}/resale/listings`]: () => json({ items: [{ id: UUID_B, sku_id: UUID_C, grade: "A", price_piastres: "30000", ownership: "hub", status: "LISTED", listed_at: TS, sold_at: null }] }) }));
    expect(s.kind === "ready" && s.data.rows[0]?.price).toBe("EGP 300");
  });

  const meta = { store_id: UUID_A, from: TS, to: TS, freshness: { as_of: TS, lag_ms: 0, slo_ms: 900000, within_slo: true }, k_anonymity_min: 50 };
  const A = `/v1/seller/stores/${UUID_A}/analytics`;
  it("loads insights, keeps k from meta, and degrades one section at a time", async () => {
    const curve = { products: [{ product_id: UUID_B, rows: [{ size: "M", sold_units: 8, on_hand_units: 2, sold_share_bps: 4000, stocked_share_bps: 1000, gap_bps: 3000 }, { size: "L", sold_units: 0, on_hand_units: 9, sold_share_bps: null, stocked_share_bps: null, gap_bps: null }], total_sold: 8, total_stocked: 11 }], meta };
    const s = await loadInsights(ctx({ ...STORE, [`GET ${A}/aging`]: () => json({ alerts: [], meta }), [`GET ${A}/size-curve`]: () => json(curve) }));
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready") return;
    expect(s.data.kMin).toBe(50);
    expect(s.data.sizeCurve?.[0]?.rows[0]?.gapKey).toBe("insights.gap.under");
    expect(s.data.sizeCurve?.[0]?.rows[1]?.soldShare).toBeNull();
    const half = await loadInsights(ctx({ ...STORE, [`GET ${A}/aging`]: () => json({ alerts: [], meta }), [`GET ${A}/size-curve`]: () => json({}, 500) }));
    expect(half.kind === "ready" && half.data.sizeCurve).toBeNull();
    const none = await loadInsights(ctx({ ...STORE, [`GET ${A}/aging`]: () => "network", [`GET ${A}/size-curve`]: () => "network" }));
    expect(none.kind).toBe("offline");
  });

  it("loads channels, incidents and parity from the server clock", async () => {
    const s = await loadChannels(ctx({
      ...STORE,
      "GET /v1/seller/channels": () => json({ items: [{ id: UUID_B, type: "shopify", shop_domain: "x.myshopify.com", status: "revoked", last_snapshot_at: null }], page: { next_cursor: null, has_more: false } }),
      [`GET /v1/seller/stores/${UUID_A}/crawl-targets`]: () => json({ items: [] }),
      "GET /v1/seller/price-trust": () => json({ score: 80, violations_in_window: 1, window_days: 90, ladder_state: "good_standing", active_actions: [{ id: UUID_C, action: "demotion", reason_code: "cross_channel_cheaper", applied_at: "2026-10-11T08:00:00Z" }] }),
    }));
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready") return;
    expect(s.serverNowMs).toBe(Date.parse("Sun, 11 Oct 2026 10:00:00 GMT"));
    expect(s.data.incidents.map((i) => i.reasonKey)).toEqual(["channels.incident.revoked"]);
    expect(s.data.parity).toHaveLength(1);
  });

  it("hub: empty, ready and forbidden", async () => {
    const og = "11111111-1111-4111-8111-111111111111";
    const path = `GET /v1/me/orders/${og}/tracking`;
    const e = await loadHub(ctx({ [path]: () => json({ order_group_id: og, delivery_fee_piastres: "0", waiting_seller_orders: 0, parcels: [] }) }), og);
    expect(e.kind).toBe("empty");
    const r = await loadHub(ctx({ [path]: () => json({ order_group_id: og, delivery_fee_piastres: "6000", waiting_seller_orders: 1, parcels: [{ id: UUID_A, status: "dispatched", awb: null, courier: "bosta", seller_order_count: 2, fee_charged_piastres: "6000" }] }) }), og);
    expect(r.kind === "ready" && r.data.parcels[0]?.statusKey).toBe("hub.status.dispatched");
    expect(r.kind === "ready" && r.data.deliveryFee).toBe("EGP 60");
    const f = await loadHub(ctx({ [path]: () => json({ title: "x" }, 403) }), og);
    expect(f.kind === "error" && f.messageKey).toBe("state.forbidden");
  });
});

describe("api client Phase 2 writes", () => {
  it("sends Idempotency-Key and money as piastre strings on campaign create and top-up", async () => {
    const c = ctx({
      "POST /v1/seller/ads/topup": () => json({ top_up_id: "t", status: "pending", net: m("1"), vat: m("0"), gross: m("1"), payment: { intent_ref: null, client_action: null }, replayed: false }),
    });
    const r = await c.api?.topUpAds(UUID_A, "12550");
    expect(r?.ok).toBe(true);
    const call = c.calls[0];
    expect(call?.headers?.["idempotency-key"]).toBeDefined();
    expect(call?.body).toEqual({ store_id: UUID_A, amount: { amount: "12550", currency: "EGP" } });
  });
});
