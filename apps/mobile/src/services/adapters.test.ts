import { SessionBagPort } from "../features/bag/session-bag";
import { describe, expect, it } from "vitest";
import { createClient, type FetchLike } from "./api-client";
import { createAdapterContext, configureApiRuntime } from "./runtime";
import type { AdapterContext } from "./wire";
import { createApiPorts } from "./api-ports";
import { HttpOutletApi } from "./http-api";
import { ApiBagPort } from "../features/bag/api";
import { ApiWorldsPort } from "../features/worlds/api";
import { ApiCategoryPort } from "../features/shop-all/api";
import { FIXTURE_CATEGORIES, resolveCategoryParam, toSearchFilter, EMPTY_SHOP_FILTERS } from "../features/shop-all/model";
import { ApiSearchPort, filterToWire } from "../features/search/api";
import { ApiWishlistsPort } from "../features/wishlists/api";
import { ApiOrdersPort } from "../features/orders/api";
import { ApiWalletPort } from "../features/wallet/api";
import { ApiPrivacyPort, mapDeletion } from "../features/privacy-center/api";
import { ApiRewardsPort } from "../features/rewards/api";
import { ApiPlusPort } from "../features/plus/api";
import { ApiReturnsPort } from "../features/returns/api";
import { ApiCheckoutPort } from "../features/checkout/api";
import { ApiSizeProfilePort, fromWireMeasurements, toWireMeasurements } from "../features/size-profile/api";
import { PortError } from "../features/worlds/model";
import { EMPTY_FILTER, InMemorySearchPort } from "../features/search/model";
import { createDefaultPorts } from "../state/ports";
import { createApi } from "../api";
import { createInMemoryPorts } from "../state/ports";

const U1 = "0192f3a4-5b6c-7d8e-9f01-23456789abc1";
const U2 = "0192f3a4-5b6c-7d8e-9f01-23456789abc2";
const U3 = "0192f3a4-5b6c-7d8e-9f01-23456789abc3";
const ORDER_GROUP = {
  id: "0192f3a4-5b6c-7d8e-9f01-23456789abc1", status: "payment_pending", payment_method: "card", seller_orders: [], subtotal: { amount: "1", currency: "EGP" },
  shipping_total: { amount: "0", currency: "EGP" }, discount_total: { amount: "0", currency: "EGP" }, vat_total: { amount: "0", currency: "EGP" },
  total_paid_or_due: { amount: "105000", currency: "EGP" }, created_at: "2026-10-11T10:00:00Z", updated_at: "2026-10-11T10:00:00Z",
};
const TS = "2026-10-11T10:00:00Z";
const egp = (n: number) => ({ amount: String(n), currency: "EGP" as const });

interface Req { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: unknown }
type Handler = (r: Req) => { status?: number; body?: unknown; headers?: Record<string, string> };

function harness(routes: Record<string, Handler>) {
  const calls: Req[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const req: Req = {
      method: init?.method ?? "GET",
      path: u.pathname,
      query: u.searchParams,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    const h = routes[`${req.method} ${req.path}`];
    if (h === undefined) return new Response(JSON.stringify({ type: "/problems/not-found", title: "nf", status: 404 }), { status: 404, headers: { "Content-Type": "application/problem+json" } });
    const r = h(req);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "Content-Type": "application/json", ...(r.headers ?? {}) } });
  };
  const client = createClient({ baseUrl: "https://api.test", fetch, getToken: () => "tok", sleep: async () => undefined, randomBytes: (n) => new Uint8Array(n).fill(3), maxRetries: 0 });
  const ctx: AdapterContext = { client, locale: () => "ar", nowMs: () => Date.parse(TS), deviceId: () => "install-device-1" };
  return { ctx, calls };
}

const page = <T>(items: T[]) => ({ items, page: { next_cursor: null, has_more: false } });
const store = { id: U1, slug: "s", name: { ar: "متجر", en: "Store" }, kind: "local", verified_badge: true, live_drop: false, is_favorite: true, max_verified_discount_pct: 40, follower_count: 3 };

describe("mobile adapters over the generated client", () => {
  it("worlds: maps stores and ranks by the server's trending order", async () => {
    const { ctx, calls } = harness({ "GET /v1/stores": () => ({ body: page([store, { ...store, id: U2 }]) }) });
    const stores = await new ApiWorldsPort(ctx).listStores();
    expect(stores.map((s) => [s.id, s.trendingRank, s.maxVerifiedDiscountPct, s.isFavourite])).toEqual([[U1, 1, 40, true], [U2, 2, 40, true]]);
    expect(calls[0]?.query.get("world")).toBe("everything");
  });

  it("categories: maps the public tree (parent/position order, en falls back to ar) and resolves slug or id route params", async () => {
    const node = (id: string, slug: string, parent: string | null, position: number, name: { ar: string; en?: string }) =>
      ({ id, slug, name, parent_id: parent, position, return_class: "standard" });
    const { ctx, calls } = harness({
      "GET /v1/public/categories": () => ({
        body: { items: [node(U3, "tshirts", U1, 0, { ar: "تيشيرتات", en: "T-shirts" }), node(U2, "denim", null, 1, { ar: "جينز" }), node(U1, "tops", null, 0, { ar: "بلوزات", en: "Tops" })] },
      }),
    });
    const tree = await new ApiCategoryPort(ctx).tree();
    expect(calls[0]?.path).toBe("/v1/public/categories");
    expect(tree.map((n) => [n.slug, n.parentId, n.nameEn])).toEqual([["tops", null, "Tops"], ["denim", null, "جينز"], ["tshirts", U1, "T-shirts"]]);
    expect(resolveCategoryParam(tree, "TOPS")).toBe(U1);
    expect(resolveCategoryParam(tree, U2)).toBe(U2);
    expect(resolveCategoryParam(tree, "nope")).toBeNull();
  });

  it("categories: the dev fake search rows carry categoryId so a category (with children) filters results", async () => {
    const id = resolveCategoryParam(FIXTURE_CATEGORIES, "dresses") ?? "";
    const page = await new InMemorySearchPort().search("", toSearchFilter([], { ...EMPTY_SHOP_FILTERS, categoryIds: [id] }, FIXTURE_CATEGORIES));
    expect(page.items.map((i) => i.id)).toEqual(["p1"]);
  });

  it("search: wire filter is snake_case JSON; money is bigint; discount shown only for verified badges", async () => {
    const { ctx, calls } = harness({
      "GET /v1/search": () => ({
        body: {
          ...page([
            { id: U1, title: { ar: "فستان" }, store, price: { price: egp(129_900), badge: "verified_discount", reference_price: egp(200_000), discount_pct: 35 }, condition: "sample", sponsored: false },
            { id: U2, title: { ar: "قميص" }, store, price: { price: egp(50_000), badge: "launch_price" }, condition: "sample", sponsored: true },
          ]),
          total_estimate: 12,
        },
      }),
    });
    const port = new ApiSearchPort(ctx);
    const r = await port.search("dress", { ...EMPTY_FILTER, budgetMax: 150_000n, conditions: ["sample"], mySizeOnly: true }, null);
    expect(r.total).toBe(12);
    expect(r.items.map((i) => [i.price, i.verifiedDiscountPct, i.sponsored])).toEqual([[129_900n, 35, false], [50_000n, null, true]]);
    expect(JSON.parse(calls[0]?.query.get("filters") ?? "{}")).toEqual({ budget_max: { amount: "150000", currency: "EGP" }, my_size_only: true, conditions: ["sample"] });
    expect(filterToWire(EMPTY_FILTER)).toEqual({});
  });

  it("bag: maps groups, unavailable lines, plus; saved-for-later reads the ETag first and sends If-Match", async () => {
    const cart = {
      id: U1, line_count: 1, updated_at: TS,
      groups: [{
        store, status: "open", merchandise_subtotal: egp(100_000), free_delivery: { threshold: egp(200_000), remaining: egp(100_000), unlocked: false, plus_member: true },
        lines: [{ id: U2, sku_id: U3, product_id: U1, title: { ar: "تيشيرت" }, qty: 2, unit_price: egp(50_000), price_at_add: egp(60_000), price_change: "dropped", availability: "unavailable" }],
      }],
    };
    const { ctx, calls } = harness({
      "GET /v1/cart": () => ({ body: cart, headers: { ETag: '"c1"' } }),
      [`PATCH /v1/cart/lines/${U2}`]: () => ({ body: cart }),
    });
    const bag = new ApiBagPort(ctx);
    const snap = await bag.load();
    expect(snap.stores[0]).toMatchObject({ id: U1, status: "active", freeDeliveryThreshold: 200_000n });
    expect(snap.lines[0]).toMatchObject({ qty: 2, unitPrice: 50_000n, priceAtAdd: 60_000n, availability: "soldOut", savedForLater: false });
    expect(snap.isPlusMember).toBe(true);
    await bag.setSavedForLater(U2, true);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.headers["If-Match"]).toBe('"c1"');
    expect(patch?.body).toEqual({ saved_for_later: true });
  });

  it("wishlists: saveItem creates the list once per intent and is idempotent per product", async () => {
    const lists: Array<{ id: string; intent: string; title: string; items: Array<{ id: string; product_id: string }> }> = [];
    const wire = (w: (typeof lists)[number]) => ({ id: w.id, intent: w.intent, title: w.title, visibility: "private", item_count: w.items.length, created_at: TS });
    const { ctx, calls } = harness({
      "GET /v1/me/wishlists": () => ({ body: page(lists.map(wire)) }),
      "POST /v1/me/wishlists": (r) => {
        const b = r.body as { intent: string; title: string };
        const w = { id: U1, intent: b.intent, title: b.title, items: [] as Array<{ id: string; product_id: string }> };
        lists.push(w);
        return { status: 201, body: wire(w) };
      },
      [`GET /v1/me/wishlists/${U1}`]: () => {
        const w = lists[0];
        return { body: { ...wire(w!), items: w!.items.map((i) => ({ id: i.id, product_id: i.product_id, added_price: egp(1000), state: "active" })) } };
      },
      [`POST /v1/wishlists/${U1}/items`]: (r) => {
        const pid = (r.body as { product_id: string }).product_id;
        lists[0]?.items.push({ id: U2, product_id: pid });
        return { status: 201, body: { id: U2, product_id: pid, added_price: egp(1000), state: "active" } };
      },
    });
    const port = new ApiWishlistsPort(ctx);
    await port.saveItem(U3, "treat", { title: "x", price: 1n });
    await port.saveItem(U3, "treat", { title: "x", price: 1n });
    expect(calls.filter((c) => c.method === "POST" && c.path === "/v1/me/wishlists").length).toBe(1);
    expect(calls.filter((c) => c.path === `/v1/wishlists/${U1}/items`).length).toBe(1);
    expect((calls.find((c) => c.method === "POST" && c.path === "/v1/me/wishlists")?.body as { intent: string }).intent).toBe("treat");
    const mapped = await port.list();
    expect(mapped[0]?.items[0]).toMatchObject({ productId: U3, addedPrice: 1000n, status: "listed" });
  });

  it("orders: maps groups and collapses return sub-states; cancel sends a keyed request and reports 4xx as not ok", async () => {
    const so = {
      id: U2, order_group_id: U1, store, status: "RETURN_IN_TRANSIT", subtotal: egp(1), shipping: egp(0), discount: egp(0), vat: egp(0), total: egp(5000),
      lines: [{ id: U3, sku_id: U3, title: { ar: "حذاء" }, qty: 1, unit_price: egp(5000), discount_alloc: egp(0), vat: egp(0) }],
      shipment: { id: U1, seller_order_ids: [U2], courier: "bosta", awb: "A1", status: "delivered", events: [{ at: TS, status: "delivered" }] },
      cancellable: false, created_at: TS,
    };
    const { ctx, calls } = harness({
      "GET /v1/me/orders": () => ({ body: page([{ id: U1, status: "completed", payment_method: "cod", seller_orders: [so], subtotal: egp(1), shipping_total: egp(0), discount_total: egp(0), vat_total: egp(0), total_paid_or_due: egp(5000), created_at: TS, updated_at: TS }]) }),
      [`POST /v1/seller-orders/${U2}/cancel`]: () => ({ status: 409, body: { type: "/problems/x", title: "no", status: 409 } }),
    });
    const port = new ApiOrdersPort(ctx);
    const groups = await port.list();
    expect(groups[0]).toMatchObject({ state: "paid", total: 5000n });
    expect(groups[0]?.sellerOrders[0]).toMatchObject({ status: "RETURN_REQUESTED", deliveredAt: TS, shipment: { courier: "bosta", awb: "A1" } });
    expect(await port.cancel(U2, U1)).toEqual({ ok: false });
    expect(calls.find((c) => c.method === "POST")?.headers["Idempotency-Key"]).toBe(U1);
  });

  it("wallet: sub-balances and expiring lots map to bigint credit lots; transactions page", async () => {
    const { ctx } = harness({
      "GET /v1/me/wallet": () => ({ body: { total: egp(7000), sub_balances: [{ kind: "gift_card", balance: egp(5000), expires_at: TS }, { kind: "goodwill", balance: egp(2000) }], expiring_soon: [{ kind: "gift_card", amount: egp(5000), expires_at: TS }], as_of: TS } }),
      "GET /v1/me/wallet/transactions": () => ({ body: { items: [{ id: U1, kind: "cashback_in", amount: egp(300), created_at: TS }], page: { next_cursor: "n", has_more: true } } }),
    });
    const port = new ApiWalletPort(ctx);
    const snap = await port.load();
    expect(snap.lots.map((l) => [l.kind, l.remaining])).toEqual([["gift_card", 5000n], ["goodwill", 2000n]]);
    expect(snap.expiringSoon[0]?.remaining).toBe(5000n);
    expect(await port.transactions(null)).toMatchObject({ nextCursor: "n", items: [{ kind: "credit_added", sub: "cashback_coins", amount: 300n }] });
  });

  it("privacy: deletion states and consent policy version round trip", async () => {
    expect(mapDeletion({ status: "blocked", blockers: [{ code: "open_order" }, { code: "open_order" }, { code: "open_return" }] })).toEqual({
      state: "blocked", blockers: [{ kind: "open_orders", count: 2 }, { kind: "open_returns", count: 1 }],
    });
    expect(mapDeletion({ status: "cancelled", blockers: [], store_credit_balance: egp(1200) })).toEqual({ state: "eligible", coolingDays: 14, forfeiture: 1200n });
    const { ctx, calls } = harness({
      "GET /v1/me/privacy/consents": () => ({ body: { consents: [{ purpose: "analytics", granted: false, updated_at: TS, policy_version: "v7" }] } }),
      "GET /v1/me/sessions": () => ({ body: page([{ id: U1, platform: "ios", created_at: TS, last_seen_at: TS, current: true }]) }),
      "PATCH /v1/me/privacy/consents": () => ({ body: { consents: [] } }),
    });
    const port = new ApiPrivacyPort(ctx);
    const snap = await port.load(); // account deletion 404 => eligible
    expect(snap.deletion).toMatchObject({ state: "eligible" });
    expect(snap.sessions[0]).toMatchObject({ id: U1, deviceLabel: "ios", current: true });
    await port.setConsent("analytics", true);
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ changes: [{ purpose: "analytics", granted: true, policy_version: "v7" }] });
  });

  it("contract fields: suggestions carry sku_id and size_label, wallet lots carry lot_id, deletion sends the acknowledgement, latest export is read", async () => {
    const product = (sku: string, size?: string) => ({
      id: U1, sku_id: sku, ...(size === undefined ? {} : { size_label: size }), title: { ar: "قميص" }, sponsored: false, condition: "new_with_tags",
      store: { id: U2, slug: "s", name: { ar: "متجر" }, kind: "local", verified_badge: true, live_drop: false, is_favorite: false },
      price: { price: egp(40_000), badge: "none", reference_price: null, discount_pct: null },
    });
    const { ctx, calls } = harness({
      "GET /v1/cart/free-delivery-suggestions": () => ({ body: { store_id: U2, remaining: egp(5000), suggestions: [product(U3, "M"), product(U2)] } }),
      "GET /v1/me/wallet": () => ({ body: { total: egp(5000), sub_balances: [{ kind: "gift_card", lot_id: "card-9", balance: egp(5000) }], expiring_soon: [], as_of: TS } }),
      "GET /v1/me/wallet/transactions": () => ({ body: { items: [{ id: U1, kind: "spend", sub_balance: "gift_card", lot_id: "card-9", amount: egp(300), created_at: TS }], page: { next_cursor: null, has_more: false } } }),
      "POST /v1/me/privacy/delete": () => ({ status: 202, body: { status: "cooling_off", blockers: [], cooling_off_ends_at: TS, store_credit_balance: egp(100) } }),
      "GET /v1/me/privacy/export/latest": () => ({ body: { id: U1, status: "queued", locale: "ar", requested_at: TS, ready_target_at: TS } }),
      "GET /v1/me/privacy/consents": () => ({ body: { consents: [] } }),
      "GET /v1/me/sessions": () => ({ body: page([]) }),
    });
    // A suggestion without a size is dropped: the bag never shows a guessed size.
    expect(await new ApiBagPort(ctx).inSizeSuggestions(U2)).toEqual([{ skuId: U3, title: "قميص", sizeLabel: "M", unitPrice: 40_000n }]);
    const wallet = new ApiWalletPort(ctx);
    expect((await wallet.load()).lots[0]?.id).toBe("card-9");
    expect((await wallet.transactions(null)).items[0]).toMatchObject({ kind: "credit_spent", sub: "gift_card" });
    const privacy = new ApiPrivacyPort(ctx);
    await privacy.requestDeletion({ acknowledgedForfeiture: true, idempotencyKey: U1 });
    expect(calls.find((c) => c.path === "/v1/me/privacy/delete")?.body).toEqual({ acknowledge_credit_forfeiture: true });
    expect((await privacy.load()).export).toMatchObject({ state: "requested" });
  });

  it("rewards: play maps the outcome and sends an idempotency key; convert is declared unsupported", async () => {
    const { ctx, calls } = harness({
      "POST /v1/games/daily_spin/play": () => ({
        body: {
          play_id: "p1", game: "daily_spin", outcome: { id: "o1", kind: "coins", coins: "25", voucher_template_id: null }, reward_ref: null, odds_version_id: "ov-3", replay: false,
          audit: { roll_ppm: 1, server_seed: "s", server_seed_hash: "h", day_key: "d", seq: 1 }, played_at: TS,
        },
      }),
    });
    const port = new ApiRewardsPort(ctx);
    expect(await port.play("spin", "ov-3", U1)).toEqual({ kind: "coins", coins: 25, oddsVersion: "ov-3" });
    expect(calls[0]?.headers["Idempotency-Key"]).toBe(U1);
    await expect(port.convert(10, U1)).rejects.toBeInstanceOf(PortError);
  });

  it("unsupported operations fail as PortError (no invented data): returns load, plus subscribe", async () => {
    const { ctx } = harness({});
    await expect(new ApiReturnsPort(ctx).load(U1)).rejects.toBeInstanceOf(PortError);
    await expect(new ApiPlusPort(ctx).subscribe("plus_monthly", U1)).rejects.toBeInstanceOf(PortError);
  });

  it("network failures surface as offline PortError", async () => {
    const client = createClient({ baseUrl: "https://api.test", fetch: async () => { throw new TypeError("down"); }, maxRetries: 0, getToken: () => "t" });
    const ctx: AdapterContext = { client, locale: () => "ar", nowMs: () => 0, deviceId: () => "d" };
    const err = await new ApiWorldsPort(ctx).listStores().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect((err as PortError).kind).toBe("offline");
  });

  it("contract drift surfaces as a failed PortError whose cause is the drift error", async () => {
    const { ctx } = harness({ "GET /v1/me/wallet": () => ({ body: { total: egp(1) } }) });
    const err = (await new ApiWalletPort(ctx).load().catch((e: unknown) => e)) as PortError & { cause?: { name?: string; operationId?: string } };
    expect(err.kind).toBe("failed");
    expect(err.cause?.name).toBe("ContractDriftError");
    expect(err.cause?.operationId).toBe("getWallet");
  });

  it("checkout: quote needs a saved address, maps totals/methods; price_changed on place re-quotes", async () => {
    const draft = { governorateId: "EG-C", cityId: "nasr", street: "St 9", building: "4", floor: "", apartment: "", landmark: "x", pin: null };
    const address = { id: U3, recipient_name: "N", phone_e164: "+201001234567", governorate_code: "EG-C", city_district_code: "nasr", street: "St 9", building: "4", courier_coverage: "covered", is_default: true, created_at: TS };
    const cart = {
      id: U1, line_count: 1, updated_at: TS,
      groups: [{ store, status: "open", merchandise_subtotal: egp(100_000), free_delivery: { threshold: egp(200_000), remaining: egp(100_000), unlocked: false },
        lines: [{ id: U2, sku_id: U3, product_id: U1, title: { ar: "تيشيرت" }, qty: 1, unit_price: egp(100_000), price_at_add: egp(100_000), price_change: "none", availability: "available" }] }],
    };
    const quote = {
      quote_id: U1, expires_at: "2026-10-11T10:10:00Z",
      groups: [{ store_id: U1, merchandise_subtotal: egp(100_000), shipping_fee: egp(5000), total: egp(105_000) }],
      fees: [], total_payable: egp(105_000),
      payment_methods: [{ method: "cod", available: true }, { method: "card", available: false, reason_code: "psp_down" }],
    };
    let place: "changed" | "ok" = "changed";
    const wallet = { total: egp(3000), sub_balances: [], expiring_soon: [], as_of: TS };
    const { ctx, calls } = harness({
      "GET /v1/me/addresses": () => ({ body: page([address]) }),
      "GET /v1/cart": () => ({ body: cart }),
      "POST /v1/checkout/quote": () => ({ body: quote }),
      "GET /v1/me/wallet": () => ({ body: wallet }),
      "POST /v1/checkout": () => (place === "changed"
        ? { status: 409, body: { type: "/problems/price-changed", title: "changed", status: 409, code: "price_changed" } }
        : { status: 201, body: { order_group: ORDER_GROUP, client_action: { type: "redirect", url: "https://pay.example/3ds" } } }),
    });
    const port = new ApiCheckoutPort(ctx);
    const q = await port.quote({ address: draft });
    expect(q.quoteId).toBe(U1);
    expect(q.storeCreditBalance).toBe(3000n);
    expect(q.shipments[0]).toMatchObject({ id: U1, storeName: "متجر" });
    expect(q.shipments[0]?.deliveryOptions[0]).toMatchObject({ fee: 5000n });
    expect(q.paymentMethods.map((m) => [m.id, m.kind, m.available])).toEqual([["cod", "cod", true], ["card", "card", false]]);
    expect(q.paymentMethods[1]?.unavailableReason).toEqual({ ar: "psp_down", en: "psp_down" });
    expect(calls.find((c) => c.path === "/v1/checkout/quote")?.body).toEqual({ address_id: U3, cart_line_ids: [U2] });

    const req = { quoteId: U1, address: draft, delivery: { [U1]: "standard" }, paymentMethodId: "card", voucherCodes: [], useStoreCredit: true, acceptedPriceDelta: 0n };
    const changed = await port.place(req, U2);
    expect(changed.kind).toBe("price_changed");

    place = "ok";
    const placed = await port.place(req, U2, "admission-token-value-xyz");
    expect(placed).toEqual({ kind: "requires_action", orderGroupId: U1, action: { type: "redirect", url: "https://pay.example/3ds" } });
    const body = calls.filter((c) => c.path === "/v1/checkout").at(-1);
    expect(body?.body).toEqual({
      quote_id: U1, address_id: U3, payment_method: "card", store_credit_amount: egp(3000), expected_total: egp(105_000), admission_token: "admission-token-value-xyz",
    });
    expect(body?.headers["Idempotency-Key"]).toBe(U2);
  });

  it("checkout: a wallet that breaks the contract degrades to zero credit and is reported, not hidden", async () => {
    const drifts: string[] = [];
    const draft = { governorateId: "g", cityId: "c", street: "s", building: "b", floor: "", apartment: "", landmark: "", pin: null };
    const { ctx } = harness({
      "GET /v1/me/addresses": () => ({ body: page([{ id: U3, recipient_name: "N", phone_e164: "+201001234567", governorate_code: "g", city_district_code: "c", street: "s", building: "b", courier_coverage: "covered", is_default: true, created_at: TS }]) }),
      "GET /v1/cart": () => ({ body: { id: U1, line_count: 0, updated_at: TS, groups: [] } }),
      "POST /v1/checkout/quote": () => ({ body: { quote_id: U1, expires_at: TS, groups: [], fees: [], total_payable: egp(0), payment_methods: [] } }),
      "GET /v1/me/wallet": () => ({ body: { total: egp(1) } }),
    });
    const q = await new ApiCheckoutPort({ ...ctx, onDrift: (e) => drifts.push(e.operationId) }).quote({ address: draft });
    expect(q.storeCreditBalance).toBe(0n);
    expect(drifts).toEqual(["getWallet"]);
  });

  it("size profiles: tenths <-> cm conversion is lossless for one-decimal values", () => {
    const m = { height: 1675, weight: 605, bust: 902 };
    const wire = toWireMeasurements(m);
    expect(wire).toEqual({ height_cm: 167.5, weight_kg: 60.5, bust_cm: 90.2 });
    expect(fromWireMeasurements(wire)).toEqual(m);
    expect(typeof ApiSizeProfilePort).toBe("function");
  });
});

describe("composition and defaults", () => {
  it("createApiPorts wires every FeaturePorts key, with the same keys as the in-memory container", () => {
    const { ctx } = harness({});
    expect(Object.keys(createApiPorts(ctx)).sort()).toEqual(Object.keys(createInMemoryPorts()).sort());
  });

  it("the stylist port is its own OutfitBagPort (the server already writes the bag)", () => {
    const { ctx } = harness({});
    const p = createApiPorts(ctx);
    expect(p.outfitBag).toBe(p.stylist);
  });

  it("createDefaultPorts: fakes without a base url; real adapters with one; a base url without a runtime fails loudly", () => {
    configureApiRuntime(null);
    expect(createDefaultPorts(null).bag.constructor.name).toBe("InMemoryBagPort");
    expect(() => createDefaultPorts("https://api.example")).toThrow(/configureApiRuntime/);
    const tokens = { load: async () => ({ accessToken: "a", refreshToken: "r", accessExpiresAtMs: 1 }), save: async () => undefined, clear: async () => undefined };
    configureApiRuntime({ baseUrl: "https://api.example", tokens: tokens as never, installId: async () => "i", locale: () => "ar", platform: "ios" });
    // The default Bag is session-aware (guest store signed out, ApiBagPort signed in, ADR-0055).
    expect(createDefaultPorts("https://api.example").bag).toBeInstanceOf(SessionBagPort);
    configureApiRuntime(null);
  });

  it("createApi no longer throws in release builds when a runtime exists, and still refuses the fixture without one", () => {
    const clock = { now: () => new Date(0) };
    const tokens = { load: async () => null, save: async () => undefined, clear: async () => undefined };
    const rt = { baseUrl: "https://api.example", tokens: tokens as never, installId: async () => "i", locale: () => "ar" as const, platform: "ios" as const };
    expect(createApi(clock, false, rt)).toBeInstanceOf(HttpOutletApi);
    expect(() => createApi(clock, false)).toThrow();
    void createAdapterContext;
  });

  it("HttpOutletApi: otp request then verify uses the remembered challenge and maps errors to ApiResult codes", async () => {
    const { ctx } = harness({
      "POST /v1/auth/otp/request": () => ({ status: 202, body: { challenge_id: U1, expires_at: TS, resend_available_at: TS, attempts_remaining: 2 } }),
      "POST /v1/auth/otp/verify": (r) => {
        const b = r.body as { code: string; challenge_id: string };
        if (b.code !== "123456") return { status: 422, body: { type: "/p", title: "bad", status: 422, code: "otp_invalid" } };
        return {
          body: {
            access_token: "a", access_expires_at: TS, refresh_token: "r", refresh_expires_at: TS,
            is_new_account: b.challenge_id === U1,
            // status age_pending must NOT decide newness any more
            user: { id: U2, locale: "ar-EG", age_band: "unverified", limited_capacity: false, phone_verified: true, status: "age_pending", created_at: TS },
          },
        };
      },
    });
    const api = new HttpOutletApi(ctx.client, async () => U3, "ios", { now: () => new Date(0) });
    expect(await api.verifyOtp({ phoneE164: "+201001234567", code: "123456" })).toMatchObject({ ok: false, error: { code: "code_expired" } });
    expect((await api.requestOtp({ phoneE164: "+201001234567", locale: "ar", idempotencyKey: U1 })).ok).toBe(true);
    expect(await api.verifyOtp({ phoneE164: "+201001234567", code: "000000" })).toMatchObject({ ok: false, error: { code: "invalid_code" } });
    const ok = await api.verifyOtp({ phoneE164: "+201001234567", code: "123456" });
    expect(ok).toMatchObject({ ok: true, value: { isNewAccount: true, tokens: { accessToken: "a", refreshToken: "r" } } });
  });

  it("verifyOtp existing_only sends the mode and maps 404 no_account and a blocked 404 apart", async () => {
    const bodies: unknown[] = [];
    const { ctx } = harness({
      "POST /v1/auth/otp/request": () => ({ status: 202, body: { challenge_id: U1, expires_at: TS, resend_available_at: TS, attempts_remaining: 2 } }),
      "POST /v1/auth/otp/verify": (r) => {
        bodies.push(r.body);
        return { status: 404, body: { type: "/p", title: "x", status: 404, code: bodies.length === 1 ? "no_account" : "not_found" } };
      },
    });
    const api = new HttpOutletApi(ctx.client, async () => U3, "ios", { now: () => new Date(0) });
    await api.requestOtp({ phoneE164: "+201001234567", locale: "ar", idempotencyKey: U1 });
    expect(await api.verifyOtp({ phoneE164: "+201001234567", code: "123456", mode: "existing_only" })).toMatchObject({ ok: false, error: { code: "no_account" } });
    expect(await api.verifyOtp({ phoneE164: "+201001234567", code: "123456", mode: "existing_only" })).toMatchObject({ ok: false, error: { code: "sign_in_unavailable" } });
    expect(bodies[0]).toMatchObject({ mode: "existing_only" });
  });
});
