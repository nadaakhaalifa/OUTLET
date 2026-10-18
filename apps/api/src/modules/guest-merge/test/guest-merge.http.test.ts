/**
 * POST /v1/me/guest-merge over HTTP on the full dev application (ADR-0055, spec guest-browsing G-1).
 * Covers: dark by default (404), the larger-quantity rule, server prices only, caps, Saved with reason codes,
 * idempotent replay (same key same response, other body 422), consent-gated recently viewed, BOLA (caller's own
 * cart only), the outbox event, 401/403 and size/shape limits.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, login, type Harness, type LoggedIn } from "../../../test/harness";
import { CART_CATALOG, type FakeCatalog } from "../../cart";
import { HISTORY_CONSENT, HISTORY_PRODUCTS, type FakeConsent, type FakeProductLookup } from "../../history";
import { WISHLIST_CATALOG, type InMemoryCatalogRead } from "../../wishlists";
import { GUEST_MERGE_UOW, type InMemoryGuestMergeUnitOfWork } from "../index";
import { GUEST_BROWSING_GATE } from "../../../platform/tokens";

let h: Harness;
let dark: Harness;
let catalog: FakeCatalog;
let wishCatalog: InMemoryCatalogRead;
let phoneSeq = 0;
let seq = 0;
const nextPhone = () => `+2010077${String(10_000 + ++phoneSeq)}`;
/** UUIDv7-shaped, unique per call (version nibble 7, variant 9). */
const uid = (): string => `0192f3a4-5b6c-7d8e-9f01-${String(++seq).padStart(12, "0")}`;
const bearer = (u: LoggedIn) => ({ Authorization: `Bearer ${u.accessToken}` });
const idem = () => ({ "Idempotency-Key": uid() });
const EGP = (pounds: bigint) => ({ amount: pounds * 100n, currency: "EGP" as const });
const AT = "2026-10-16T10:00:00.000Z";
const STORE = uid();
const CLOSED = uid();

function addSku(over: { store?: string; pounds?: bigint; available?: boolean } = {}): { sku: string; product: string } {
  const sku = uid();
  const product = uid();
  catalog.addSku({
    skuId: sku,
    productId: product,
    storeId: over.store ?? STORE,
    title: { ar: "قميص", en: "Shirt" },
    sizeLabel: "M",
    unitPrice: EGP(over.pounds ?? 100n),
    available: over.available ?? true,
  });
  wishCatalog.seed({
    id: product,
    listed: true,
    currentPrice: EGP(over.pounds ?? 100n),
    skuIds: [sku],
    summary: { id: product },
  });
  return { sku, product };
}

const line = (sku: string, qty = 1, saved = false) => ({ sku_id: sku, qty, saved_for_later: saved, added_at: AT });
const merge = (u: LoggedIn, body: unknown, key = uid()) =>
  h.http().post("/v1/me/guest-merge").set(bearer(u)).set({ "Idempotency-Key": key }).send(body as object);
const getCart = (u: LoggedIn) => h.http().get("/v1/cart").set(bearer(u));
const listWishlists = (u: LoggedIn) => h.http().get("/v1/me/wishlists").set(bearer(u));
type CartBody = { line_count: number; groups: { lines: { sku_id: string; qty: number; price_at_add: { amount: string }; saved_for_later?: boolean }[] }[] };
const cartLines = (b: CartBody) => b.groups.flatMap((g) => g.lines);

beforeAll(async () => {
  h = await createHarness({
    customise: (b) => b.overrideProvider(GUEST_BROWSING_GATE).useValue({ enabled: async () => true }),
  });
  dark = await createHarness();
  catalog = h.app.get<FakeCatalog>(CART_CATALOG, { strict: false });
  wishCatalog = h.app.get<InMemoryCatalogRead>(WISHLIST_CATALOG, { strict: false });
  catalog.addStore(STORE);
  catalog.addStore(CLOSED);
  catalog.setStoreOpen(CLOSED, false);
}, 60_000);
afterAll(async () => {
  await h.close();
  await dark.close();
});
beforeEach(() => {
  h.clock.advance(61_000);
});

describe("dark by default", () => {
  it("answers 404 for an authenticated shopper while flag.guest_browsing is blocked, and reads nothing", async () => {
    const u = await login(dark, nextPhone());
    const r = await dark
      .http()
      .post("/v1/me/guest-merge")
      .set(bearer(u))
      .set(idem())
      .send({ bag_lines: [line(uid())] });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("not_found");
    // Even an invalid body is a 404, not a 400: the route does not exist while blocked.
    const bad = await dark.http().post("/v1/me/guest-merge").set(bearer(u)).set(idem()).send({ nonsense: true });
    expect(bad.status).toBe(404);
  });
});

describe("authentication", () => {
  it("is 401 without a token", async () => {
    const r = await h.http().post("/v1/me/guest-merge").set(idem()).send({});
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("unauthenticated");
  });
  it("is 400 without an Idempotency-Key", async () => {
    const u = await login(h, nextPhone());
    const r = await h.http().post("/v1/me/guest-merge").set(bearer(u)).send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("invalid_idempotency_key");
  });
});

describe("the bag merge", () => {
  it("keeps the LARGER quantity (guest 2, account 3 -> 3) and reports it unchanged", async () => {
    const u = await login(h, nextPhone());
    const { sku } = addSku();
    const add = await h.http().post("/v1/cart/lines").set(bearer(u)).set(idem()).send({ sku_id: sku, qty: 3 });
    expect(add.status).toBe(201);
    const r = await merge(u, { bag_lines: [line(sku, 2)] });
    expect(r.status).toBe(200);
    expect(cartLines(r.body.cart).map((l) => [l.sku_id, l.qty])).toEqual([[sku, 3]]);
    expect(r.body.outcome.lines).toEqual([{ sku_id: sku, result: "unchanged", reason: null, qty: 3, previous_qty: 3 }]);
  });

  it("raises the account quantity when the guest holds more, and says so", async () => {
    const u = await login(h, nextPhone());
    const { sku } = addSku();
    await h.http().post("/v1/cart/lines").set(bearer(u)).set(idem()).send({ sku_id: sku, qty: 2 });
    const r = await merge(u, { bag_lines: [line(sku, 5)] });
    expect(cartLines(r.body.cart)[0]?.qty).toBe(5);
    expect(r.body.outcome.lines[0]).toMatchObject({ result: "qty_raised", qty: 5, previous_qty: 2 });
  });

  it("uses the SERVER price; a price field in the body is refused (strict body)", async () => {
    const u = await login(h, nextPhone());
    const { sku } = addSku({ pounds: 250n });
    const bad = await merge(u, { bag_lines: [{ ...line(sku, 1), unit_price: { amount: "1", currency: "EGP" } }] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("validation_failed");
    expect((await getCart(u)).body.line_count).toBe(0);
    const ok = await merge(u, { bag_lines: [line(sku, 1)] });
    expect(cartLines(ok.body.cart)[0]?.price_at_add.amount).toBe("25000");
  });

  it("does not add unavailable, unknown or suspended-store SKUs; an unavailable product moves to Saved with a reason", async () => {
    const u = await login(h, nextPhone());
    const good = addSku();
    const soldOut = addSku({ available: false });
    const closed = addSku({ store: CLOSED });
    const r = await merge(u, { bag_lines: [line(good.sku), line(soldOut.sku), line(closed.sku), line(uid())] });
    expect(r.status).toBe(200);
    expect(cartLines(r.body.cart).map((l) => l.sku_id)).toEqual([good.sku]);
    const by = Object.fromEntries(r.body.outcome.lines.map((l: { sku_id: string; result: string; reason: string | null }) => [l.sku_id, [l.result, l.reason]]));
    expect(by[good.sku]).toEqual(["added", null]);
    expect(by[soldOut.sku]).toEqual(["unavailable", "unavailable"]);
    expect(by[closed.sku]).toEqual(["store_suspended", null]);
    expect(r.body.outcome.saved).toMatchObject({ added: 1 });
    const lists = await listWishlists(u);
    expect(lists.body.items).toHaveLength(1);
    expect(lists.body.items[0].intent).toBe("want");
  });

  it("respects the 50-line cap: overflow lines go to Saved as over_cap and existing lines are untouched", async () => {
    const u = await login(h, nextPhone());
    const existing: string[] = [];
    for (let i = 0; i < 49; i += 1) {
      const { sku } = addSku();
      existing.push(sku);
      const r = await h.http().post("/v1/cart/lines").set(bearer(u)).set(idem()).send({ sku_id: sku, qty: 1 });
      expect(r.status).toBe(201);
    }
    const a = addSku();
    const b = addSku();
    const c = addSku();
    const r = await merge(u, {
      bag_lines: [line(a.sku), line(b.sku), line(c.sku)].map((l, i) => ({ ...l, added_at: `2026-10-16T10:00:0${i}.000Z` })),
    });
    expect(r.status).toBe(200);
    expect(r.body.cart.line_count).toBe(50);
    expect(r.body.outcome.lines.map((l: { result: string; reason: string | null }) => [l.result, l.reason])).toEqual([
      ["added", null],
      ["moved_to_saved", "over_cap"],
      ["moved_to_saved", "over_cap"],
    ]);
    expect(r.body.outcome.saved.added).toBe(2);
    for (const s of existing) expect(cartLines(r.body.cart).some((l) => l.sku_id === s)).toBe(true);
  });

  it("saved items: intents become lists, a second merge reports duplicates and changes nothing", async () => {
    const u = await login(h, nextPhone());
    const p1 = addSku();
    const p2 = addSku();
    const body = {
      saved: [
        { product_id: p1.product, sku_id: p1.sku, intent: "need" },
        { product_id: p2.product, intent: "later" },
        { product_id: uid(), intent: "want" },
      ],
    };
    const first = await merge(u, body);
    expect(first.status).toBe(200);
    expect(first.body.outcome.saved).toEqual({ added: 2, duplicates: 0, over_cap: 0, unavailable: 1 });
    const second = await merge(u, body);
    expect(second.body.outcome.saved).toEqual({ added: 0, duplicates: 2, over_cap: 0, unavailable: 1 });
    const intents = (await listWishlists(u)).body.items.map((l: { intent: string }) => l.intent).sort();
    expect(intents).toEqual(["buy_later_this_month", "need"]);
  });

  it("merging the same bag twice (new keys) leaves the cart as after the first merge", async () => {
    const u = await login(h, nextPhone());
    const a = addSku();
    const b = addSku();
    const body = { bag_lines: [line(a.sku, 4), line(b.sku, 1, true)] };
    const first = await merge(u, body);
    const second = await merge(u, body);
    const strip = (c: CartBody) => cartLines(c).map((l) => [l.sku_id, l.qty, l.saved_for_later ?? false]).sort();
    expect(strip(second.body.cart)).toEqual(strip(first.body.cart));
    expect(second.body.outcome.lines.every((l: { result: string }) => l.result === "unchanged")).toBe(true);
  });
});

describe("idempotency", () => {
  it("replaying the same key and body returns the same response and writes nothing twice", async () => {
    const u = await login(h, nextPhone());
    const { sku, product } = addSku();
    const key = uid();
    const body = { bag_lines: [line(sku, 2)], saved: [{ product_id: product, intent: "treat" }] };
    const uow = h.app.get<InMemoryGuestMergeUnitOfWork>(GUEST_MERGE_UOW, { strict: false });
    const before = uow.events.length;
    const first = await merge(u, body, key);
    const again = await merge(u, body, key);
    expect(again.status).toBe(first.status);
    expect(again.body).toEqual(first.body);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.headers["cache-control"]).toBe("private, no-store");
    expect(uow.events.length).toBe(before + 1);
    expect((await listWishlists(u)).body.items).toHaveLength(1);
  });

  it("the same key with a different body is 422", async () => {
    const u = await login(h, nextPhone());
    const { sku } = addSku();
    const key = uid();
    expect((await merge(u, { bag_lines: [line(sku, 2)] }, key)).status).toBe(200);
    const r = await merge(u, { bag_lines: [line(sku, 3)] }, key);
    expect(r.status).toBe(422);
  });

  it("another user's use of the same key is a separate record (no cross-user replay)", async () => {
    const a = await login(h, nextPhone());
    const b = await login(h, nextPhone());
    const { sku } = addSku();
    const key = uid();
    const ra = await merge(a, { bag_lines: [line(sku, 2)] }, key);
    const rb = await merge(b, { bag_lines: [line(sku, 2)] }, key);
    expect(rb.status).toBe(200);
    expect(rb.body.cart.cart_id ?? rb.body.cart.id).not.toBe(ra.body.cart.cart_id ?? ra.body.cart.id);
    expect(cartLines(rb.body.cart)[0]?.qty).toBe(2);
  });
});

describe("BOLA and the outbox", () => {
  it("merges only into the caller's own cart; another user's bag is untouched and absent from the response", async () => {
    const a = await login(h, nextPhone());
    const b = await login(h, nextPhone());
    const mine = addSku();
    const theirs = addSku();
    await h.http().post("/v1/cart/lines").set(bearer(b)).set(idem()).send({ sku_id: theirs.sku, qty: 1 });
    const r = await merge(a, { bag_lines: [line(mine.sku, 1)] });
    expect(JSON.stringify(r.body)).not.toContain(theirs.sku);
    expect(JSON.stringify(r.body)).not.toContain(b.userId);
    expect(cartLines((await getCart(b)).body).map((l) => l.sku_id)).toEqual([theirs.sku]);
  });

  it("writes one cart.guest_merged event with counts only, and none when nothing changed", async () => {
    const u = await login(h, nextPhone());
    const { sku } = addSku();
    const uow = h.app.get<InMemoryGuestMergeUnitOfWork>(GUEST_MERGE_UOW, { strict: false });
    const before = uow.events.length;
    await merge(u, { bag_lines: [line(sku, 2)] });
    expect(uow.events).toHaveLength(before + 1);
    const e = uow.events[before];
    expect(e?.type).toBe("cart.guest_merged");
    expect(e?.userId).toBe(u.userId);
    expect(e?.counts).toEqual({ added: 1, qtyRaised: 0, movedToSaved: 0, unavailable: 0, storeSuspended: 0, savedAdded: 0 });
    expect(JSON.stringify(e)).not.toContain(sku);
    await merge(u, { bag_lines: [line(sku, 2)] });
    expect(uow.events).toHaveLength(before + 1);
  });
});

describe("recently viewed is consent-gated", () => {
  it("ignores recently_viewed without the personalization consent, records it with consent", async () => {
    const u = await login(h, nextPhone());
    const { product } = addSku();
    h.app.get<FakeProductLookup>(HISTORY_PRODUCTS, { strict: false }).set({
      productId: product,
      storeId: STORE,
      categoryId: uid(),
      priceMinor: 10_000n,
      storeActive: true,
    });
    const view = [{ product_id: product, viewed_at: AT }];
    const no = await merge(u, { recently_viewed: view });
    expect(no.body.outcome.viewed).toBe("ignored_no_consent");
    expect((await h.http().get("/v1/me/recently-viewed").set(bearer(u))).body.items ?? []).toHaveLength(0);

    h.app.get<FakeConsent>(HISTORY_CONSENT, { strict: false }).grant(u.userId);
    const yes = await merge(u, { recently_viewed: view });
    expect(yes.body.outcome.viewed).toBe("accepted");
    expect((await h.http().get("/v1/me/recently-viewed").set(bearer(u))).body.items).toHaveLength(1);
  });
});

describe("limits and shape", () => {
  it("413 for more than 50 bag lines, 200 saved items or 100 recently viewed", async () => {
    const u = await login(h, nextPhone());
    const lines = Array.from({ length: 51 }, () => line(uid()));
    expect((await merge(u, { bag_lines: lines })).status).toBe(413);
    const saved = Array.from({ length: 201 }, () => ({ product_id: uid(), intent: "want" }));
    expect((await merge(u, { saved })).status).toBe(413);
    const viewed = Array.from({ length: 101 }, () => ({ product_id: uid(), viewed_at: AT }));
    expect((await merge(u, { recently_viewed: viewed })).status).toBe(413);
  });

  it("accepts exactly the caps", async () => {
    const u = await login(h, nextPhone());
    const lines = Array.from({ length: 50 }, () => line(addSku().sku));
    const r = await merge(u, { bag_lines: lines });
    expect(r.status).toBe(200);
    expect(r.body.cart.line_count).toBe(50);
  });

  it.each([
    ["qty 0", { bag_lines: [line(uid(), 0)] }],
    ["qty 11", { bag_lines: [line(uid(), 11)] }],
    ["bad sku id", { bag_lines: [{ ...line(uid()), sku_id: "not-a-uuid" }] }],
    ["unknown top-level key", { bag_lines: [], cart_id: uid() }],
    ["unknown line key", { bag_lines: [{ ...line(uid()), price: 1 }] }],
    ["bad intent", { saved: [{ product_id: uid(), intent: "gift_for_someone" }] }],
    ["bad timestamp", { bag_lines: [{ ...line(uid()), added_at: "yesterday" }] }],
  ])("400 for %s", async (_name, body) => {
    const u = await login(h, nextPhone());
    const r = await merge(u, body);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("validation_failed");
  });

  it("an empty body merges nothing and returns the account bag", async () => {
    const u = await login(h, nextPhone());
    const r = await merge(u, {});
    expect(r.status).toBe(200);
    expect(r.body.outcome).toEqual({ lines: [], saved: { added: 0, duplicates: 0, over_cap: 0, unavailable: 0 }, viewed: "accepted" });
    expect(r.headers["cache-control"]).toBe("private, no-store");
  });

  it("503 catalog_unavailable when the catalog is down: nothing is merged", async () => {
    const u = await login(h, nextPhone());
    const { sku } = addSku();
    catalog.failing = true;
    try {
      const r = await merge(u, { bag_lines: [line(sku, 1)] });
      expect(r.status).toBe(503);
      expect(r.body.code).toBe("catalog_unavailable");
    } finally {
      catalog.failing = false;
    }
    expect((await getCart(u)).body.line_count).toBe(0);
  });
});

describe("a raised quantity keeps the add-time baseline", () => {
  it("changes only qty: price_at_add stays the price when the shopper added it, even after a price change", async () => {
    const u = await login(h, nextPhone());
    const { sku } = addSku({ pounds: 100n });
    await h.http().post("/v1/cart/lines").set(bearer(u)).set(idem()).send({ sku_id: sku, qty: 2 });
    catalog.setPrice(sku, EGP(150n));
    const r = await merge(u, { bag_lines: [line(sku, 5)] });
    const l = cartLines(r.body.cart)[0];
    expect(l?.qty).toBe(5);
    expect(l?.price_at_add.amount).toBe("10000");
  });
});

describe("concurrent merges", () => {
  it("two simultaneous first merges create ONE default list and one item, and a single bag line", async () => {
    const u = await login(h, nextPhone());
    const { sku, product } = addSku();
    const body = { bag_lines: [line(sku, 2)], saved: [{ product_id: product, intent: "want" }] };
    const [a, b] = await Promise.all([merge(u, body), merge(u, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 200]);
    const lists = (await listWishlists(u)).body.items as { id: string; item_count?: number }[];
    expect(lists).toHaveLength(1);
    expect(cartLines((await getCart(u)).body).map((l) => [l.sku_id, l.qty])).toEqual([[sku, 2]]);
  });
});

