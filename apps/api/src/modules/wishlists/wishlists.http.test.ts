import { buildAccessClaims } from "@outlet/auth-core";
import type { Test } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AUTHENTICATOR, type Authenticator } from "../../platform";
import { login, type Harness } from "../../test/harness";
import type { InMemoryCatalogRead, InMemoryOwnerProfiles, InMemoryWishlistEventLog } from "./index";
import { HANDLE_CATALOG_SIGNAL, SCHEDULE_DATE_ALERTS, WISHLIST_CATALOG, WISHLIST_EVENTS, WISHLIST_OWNER_PROFILES } from "./index";
import type { HandleCatalogSignal, ScheduleDateAlerts } from "./index";
import { createWishlistHarness } from "./test/harness";

const P_DRESS = "0192f3a4-5b6c-7d8e-9f01-0000000000a1";
const P_SHOES = "0192f3a4-5b6c-7d8e-9f01-0000000000a2";
const P_GONE = "0192f3a4-5b6c-7d8e-9f01-0000000000a3";
const SKU_M = "0192f3a4-5b6c-7d8e-9f01-0000000000b1";
const SKU_L = "0192f3a4-5b6c-7d8e-9f01-0000000000b2";
const MISSING = "0192f3a4-5b6c-7d8e-9f01-0000000000ff";
const UNKNOWN_PRODUCT = "0192f3a4-5b6c-7d8e-9f01-0000000000ee";

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const egp = (n: string) => ({ amount: n, currency: "EGP" });
const summary = (id: string, title: string) => ({
  id,
  title: { ar: title },
  store: { id: "0192f3a4-5b6c-7d8e-9f01-0000000000c1", name: { ar: "متجر" } },
  price: { current: egp("129900") },
  condition: "new_with_tags",
  sponsored: false,
});

let h: Harness;
let a: { token: string; userId: string; sessionId: string };
let b: { token: string; userId: string; sessionId: string };
let catalog: InMemoryCatalogRead;
let events: InMemoryWishlistEventLog;
let owners: InMemoryOwnerProfiles;
let signals: HandleCatalogSignal;
let dateJob: ScheduleDateAlerts;

async function mk(token: string, body: Record<string, unknown> = { intent: "need", title: "My list" }) {
  const r = await h.http().post("/v1/me/wishlists").set(bearer(token)).send(body);
  if (r.status !== 201) throw new Error(`create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string };
}
const addItem = (token: string, listId: string, body: Record<string, unknown>) =>
  h.http().post(`/v1/wishlists/${listId}/items`).set(bearer(token)).send(body);

beforeAll(async () => {
  h = await createWishlistHarness();
  const s1 = await login(h, "+201001230001");
  const s2 = await login(h, "+201001230002");
  a = { token: s1.accessToken, userId: s1.userId, sessionId: s1.sessionId };
  b = { token: s2.accessToken, userId: s2.userId, sessionId: s2.sessionId };
  catalog = h.app.get<InMemoryCatalogRead>(WISHLIST_CATALOG, { strict: false });
  events = h.app.get<InMemoryWishlistEventLog>(WISHLIST_EVENTS, { strict: false });
  owners = h.app.get<InMemoryOwnerProfiles>(WISHLIST_OWNER_PROFILES, { strict: false });
  signals = h.app.get<HandleCatalogSignal>(HANDLE_CATALOG_SIGNAL, { strict: false });
  dateJob = h.app.get<ScheduleDateAlerts>(SCHEDULE_DATE_ALERTS, { strict: false });
  catalog.seed({ id: P_DRESS, listed: true, currentPrice: { amount: 129_900n, currency: "EGP" }, skuIds: [SKU_M, SKU_L], summary: summary(P_DRESS, "فستان") });
  catalog.seed({ id: P_SHOES, listed: true, currentPrice: { amount: 89_900n, currency: "EGP" }, skuIds: [], summary: summary(P_SHOES, "حذاء") });
  catalog.seed({ id: P_GONE, listed: true, currentPrice: { amount: 50_000n, currency: "EGP" }, skuIds: [], summary: summary(P_GONE, "قميص") });
}, 60_000);
afterAll(async () => {
  await h.close();
});

/** Access tokens are short lived and some tests move the clock by days: mint a fresh one per test. */
async function mint(user: { userId: string; sessionId: string }, tag: string): Promise<string> {
  const authn = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false }) as unknown as {
    issue(c: unknown): Promise<string>;
  };
  return authn.issue(
    buildAccessClaims({
      issuer: h.config.tokenIssuer,
      userId: user.userId,
      audience: "buyer_api",
      sessionId: user.sessionId,
      jti: `jti-${tag}-${Math.random().toString(36).slice(2)}`,
      amr: ["otp_sms"],
      nowMs: h.clock.nowMs(),
    }),
  );
}
beforeEach(async () => {
  a = { ...a, token: await mint(a, "a") };
  b = { ...b, token: await mint(b, "b") };
});

describe("create, read, update, delete", () => {
  it("creates a list with an intent, budget and date and reads it back with an ETag", async () => {
    const created = await h
      .http()
      .post("/v1/me/wishlists")
      .set(bearer(a.token))
      .send({ intent: "birthday", title: "عيد ميلادي", target_date: "2027-02-01", budget: egp("500000") });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      intent: "birthday",
      title: "عيد ميلادي",
      target_date: "2027-02-01",
      budget: egp("500000"),
      cool_off_enabled: false,
      visibility: "private",
      item_count: 0,
    });
    expect(Object.keys(created.body).sort()).toEqual(
      ["budget", "cool_off_enabled", "created_at", "id", "intent", "item_count", "target_date", "title", "visibility"].sort(),
    );
    const got = await h.http().get(`/v1/me/wishlists/${created.body.id}`).set(bearer(a.token));
    expect(got.status).toBe(200);
    expect(got.body.items).toEqual([]);
    const etag = got.headers["etag"];
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await h.http().get(`/v1/me/wishlists/${created.body.id}`).set(bearer(a.token)).set("If-None-Match", etag ?? "");
    expect(again.status).toBe(304);
  });

  it("returns 422 for rule violations and 400 for malformed bodies", async () => {
    const post = (body: unknown) => h.http().post("/v1/me/wishlists").set(bearer(a.token)).send(body as object);
    expect((await post({ intent: "treat", title: "x", cool_off_enabled: true })).body.code).toBe("cool_off_requires_want");
    expect((await post({ intent: "gift_for_someone", title: "x" })).body.code).toBe("gift_for_required");
    expect((await post({ intent: "need", title: "x", budget: egp("0") })).body.code).toBe("budget_invalid");
    expect((await post({ intent: "need", title: "x", target_date: "2020-01-01" })).body.code).toBe("target_date_in_past");
    const bad = await post({ intent: "nope", title: "x" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("validation_failed");
    expect((await post({ intent: "need", title: "x", extra: 1 })).status).toBe(400);
    expect((await post({ intent: "need", title: "x", budget: { amount: 12.5, currency: "EGP" } })).status).toBe(400);
  });

  it("updates with If-Match, answers 428 without it and 412 when stale", async () => {
    const l = await mk(a.token, { intent: "want", title: "Wants" });
    const first = await h.http().get(`/v1/me/wishlists/${l.id}`).set(bearer(a.token));
    const etag = first.headers["etag"] ?? "";
    const patch = (tag?: string) => {
      const r = h.http().patch(`/v1/me/wishlists/${l.id}`).set(bearer(a.token));
      return (tag === undefined ? r : r.set("If-Match", tag)).send({ title: "Renamed", cool_off_enabled: true });
    };
    expect((await patch()).status).toBe(428);
    expect((await patch('"stale"')).status).toBe(412);
    const ok = await patch(etag);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ title: "Renamed", cool_off_enabled: true });
    expect((await patch(etag)).status).toBe(412); // etag moved on
    expect((await h.http().patch(`/v1/me/wishlists/${l.id}`).set(bearer(a.token)).set("If-Match", "*").send({})).status).toBe(400);
  });

  it("deletes a list and then it is gone", async () => {
    const l = await mk(a.token);
    expect((await h.http().delete(`/v1/me/wishlists/${l.id}`).set(bearer(a.token))).status).toBe(204);
    expect((await h.http().get(`/v1/me/wishlists/${l.id}`).set(bearer(a.token))).status).toBe(404);
  });

  it("pages lists with an opaque cursor, newest first, without gaps or repeats", async () => {
    const s = await login(h, "+201001230009");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.unshift((await mk(s.accessToken, { intent: "custom", title: `L${i}` })).id);
      h.clock.advance(10);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const r = await h
        .http()
        .get("/v1/me/wishlists")
        .query({ limit: 2, ...(cursor !== undefined ? { cursor } : {}) })
        .set(bearer(s.accessToken));
      expect(r.status).toBe(200);
      for (const w of r.body.items as { id: string }[]) seen.push(w.id);
      if (!r.body.page.has_more) break;
      cursor = r.body.page.next_cursor as string;
    }
    expect(seen).toEqual(ids);
    expect((await h.http().get("/v1/me/wishlists").query({ cursor: "!!" }).set(bearer(s.accessToken))).status).toBe(400);
    expect((await h.http().get("/v1/me/wishlists").query({ limit: 51 }).set(bearer(s.accessToken))).status).toBe(400);
  });
});

describe("items, cool-off and ghosts", () => {
  it("adds an item at the catalog price; the client cannot set it", async () => {
    const l = await mk(a.token);
    const r = await addItem(a.token, l.id, { product_id: P_DRESS, sku_pref: SKU_M, note: "للعيد" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      product_id: P_DRESS,
      sku_pref: SKU_M,
      added_price: egp("129900"),
      current_price: egp("129900"),
      state: "active",
      cool_off_until: null,
    });
    expect((await addItem(a.token, l.id, { product_id: P_DRESS, sku_pref: SKU_M })).body.code).toBe("duplicate_item");
    expect((await addItem(a.token, l.id, { product_id: P_DRESS, added_price: egp("1") })).status).toBe(400);
    expect((await addItem(a.token, l.id, { product_id: UNKNOWN_PRODUCT })).body.code).toBe("product_unavailable");
    expect((await addItem(a.token, l.id, { product_id: P_SHOES, sku_pref: SKU_M })).body.code).toBe("sku_not_in_product");
  });

  it("computes the 24 h cool-off on the server and drops it when the time has passed", async () => {
    const l = await mk(a.token, { intent: "want", title: "Cool", cool_off_enabled: true });
    const added = await addItem(a.token, l.id, { product_id: P_SHOES });
    expect(added.status).toBe(201);
    const until = Date.parse(added.body.cool_off_until as string);
    expect(until - h.clock.nowMs()).toBe(24 * 3600 * 1000);
    h.clock.advance(24 * 3600 * 1000 - 1);
    a = { ...a, token: await mint(a, "a") };
    let d = await h.http().get(`/v1/me/wishlists/${l.id}`).set(bearer(a.token));
    expect(d.body.items[0].cool_off_until).not.toBeNull();
    h.clock.advance(1);
    a = { ...a, token: await mint(a, "a") };
    d = await h.http().get(`/v1/me/wishlists/${l.id}`).set(bearer(a.token));
    expect(d.body.items[0].cool_off_until).toBeNull();
  });

  it("does not set a cool-off on lists without it", async () => {
    const l = await mk(a.token, { intent: "want", title: "No cool-off" });
    const r = await addItem(a.token, l.id, { product_id: P_SHOES });
    expect(r.body.cool_off_until).toBeNull();
  });

  it("keeps a delisted product as a ghost with no current price", async () => {
    const l = await mk(a.token);
    await addItem(a.token, l.id, { product_id: P_GONE });
    catalog.seed({ id: P_GONE, listed: false, currentPrice: null, skuIds: [], summary: summary(P_GONE, "قميص") });
    const d = await h.http().get(`/v1/me/wishlists/${l.id}`).set(bearer(a.token));
    expect(d.body.items[0]).toMatchObject({ state: "delisted_ghost", current_price: null, added_price: egp("50000") });
    catalog.seed({ id: P_GONE, listed: true, currentPrice: { amount: 50_000n, currency: "EGP" }, skuIds: [], summary: summary(P_GONE, "قميص") });
  });

  it("degrades honestly when the catalog is down: no ghost, no price", async () => {
    const l = await mk(a.token);
    await addItem(a.token, l.id, { product_id: P_DRESS });
    catalog.failing = true;
    try {
      const d = await h.http().get(`/v1/me/wishlists/${l.id}`).set(bearer(a.token));
      expect(d.status).toBe(200);
      expect(d.body.items[0]).toMatchObject({ state: "active", current_price: null });
      expect((await addItem(a.token, l.id, { product_id: P_SHOES })).status).toBe(503);
    } finally {
      catalog.failing = false;
    }
  });

  it("removes an item and answers 404 for an unknown item", async () => {
    const l = await mk(a.token);
    const i = await addItem(a.token, l.id, { product_id: P_SHOES });
    expect((await h.http().delete(`/v1/wishlists/${l.id}/items/${i.body.id}`).set(bearer(a.token))).status).toBe(204);
    expect((await h.http().delete(`/v1/wishlists/${l.id}/items/${i.body.id}`).set(bearer(a.token))).status).toBe(404);
  });
});

describe("sharing", () => {
  it("issues a hashed 128-bit token, serves the shared view with no PII and revokes immediately", async () => {
    owners.set(a.userId, "Nada");
    const l = await mk(a.token, { intent: "gift_for_someone", title: "Sara's wedding", gift_for: { nickname: "Sara", occasion: "Wedding" } });
    await addItem(a.token, l.id, { product_id: P_DRESS });
    const s = await h.http().post(`/v1/me/wishlists/${l.id}/share`).set(bearer(a.token)).send({});
    expect(s.status).toBe(201);
    const url = s.body.url as string;
    const token = url.split("/").pop() ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Object.keys(s.body).sort()).toEqual(["created_at", "expires_at", "url"]);

    const detail = await h.http().get(`/v1/me/wishlists/${l.id}`).set(bearer(a.token));
    expect(detail.body.visibility).toBe("shared");
    expect(JSON.stringify(detail.body)).not.toContain(token);

    const shared = await h.http().get(`/v1/shared/wishlists/${token}`);
    expect(shared.status).toBe(200);
    expect(shared.body).toMatchObject({ title: "Sara's wedding", intent: "gift_for_someone", owner_nickname: "Nada" });
    expect(shared.body.items).toHaveLength(1);
    expect(shared.body.items[0].price_hidden).toBe(false);
    expect(Object.keys(shared.body).sort()).toEqual(["intent", "items", "owner_nickname", "title"]);
    const text = JSON.stringify(shared.body);
    for (const leak of [a.userId, l.id, "address", "phone", "budget", "gift_for\"", "item_count"]) {
      expect(text.includes(leak), `leaked ${leak}`).toBe(false);
    }

    expect((await h.http().delete(`/v1/me/wishlists/${l.id}/share`).set(bearer(a.token))).status).toBe(204);
    const gone = await h.http().get(`/v1/shared/wishlists/${token}`);
    expect(gone.status).toBe(404);
    const never = await h.http().get(`/v1/shared/wishlists/${"A".repeat(22)}`);
    expect(never.status).toBe(404);
    const { request_id: _a, ...goneBody } = gone.body as Record<string, unknown>;
    const { request_id: _b, ...neverBody } = never.body as Record<string, unknown>;
    expect(goneBody).toEqual(neverBody);
    expect(events.events.map((e) => e.type)).toEqual(expect.arrayContaining(["wishlist.shared", "wishlist.share_revoked"]));
  });

  it("expires links and rotates tokens", async () => {
    const l = await mk(a.token);
    const soon = new Date(h.clock.nowMs() + 60_000).toISOString();
    const s1 = await h.http().post(`/v1/me/wishlists/${l.id}/share`).set(bearer(a.token)).send({ expires_at: soon });
    const t1 = (s1.body.url as string).split("/").pop() ?? "";
    expect((await h.http().get(`/v1/shared/wishlists/${t1}`)).status).toBe(200);
    h.clock.advance(60_000);
    expect((await h.http().get(`/v1/shared/wishlists/${t1}`)).status).toBe(404);
    expect((await h.http().get(`/v1/me/wishlists/${l.id}`).set(bearer(a.token))).body.visibility).toBe("private");

    const s2 = await h.http().post(`/v1/me/wishlists/${l.id}/share`).set(bearer(a.token)).send({});
    const s3 = await h.http().post(`/v1/me/wishlists/${l.id}/share`).set(bearer(a.token)).send({});
    const t2 = (s2.body.url as string).split("/").pop() ?? "";
    const t3 = (s3.body.url as string).split("/").pop() ?? "";
    expect(t2).not.toBe(t3);
    expect((await h.http().get(`/v1/shared/wishlists/${t2}`)).status).toBe(404);
    expect((await h.http().get(`/v1/shared/wishlists/${t3}`)).status).toBe(200);

    const past = new Date(h.clock.nowMs() - 1000).toISOString();
    expect((await h.http().post(`/v1/me/wishlists/${l.id}/share`).set(bearer(a.token)).send({ expires_at: past })).body.code).toBe("share_expiry_invalid");
  });

  it("gift wrap hides prices, omits ghosts and never exposes an address", async () => {
    const l = await mk(a.token, { intent: "birthday", title: "Birthday" });
    await addItem(a.token, l.id, { product_id: P_DRESS });
    await addItem(a.token, l.id, { product_id: P_GONE });
    catalog.seed({ id: P_GONE, listed: false, currentPrice: null, skuIds: [], summary: summary(P_GONE, "قميص") });
    const s = await h.http().post(`/v1/me/wishlists/${l.id}/share`).set(bearer(a.token)).send({ hide_prices_from_owner: true });
    const token = (s.body.url as string).split("/").pop() ?? "";
    const shared = await h.http().get(`/v1/shared/wishlists/${token}`);
    expect(shared.body.items).toHaveLength(1);
    expect(shared.body.items[0].price_hidden).toBe(true);
    expect(shared.body.items[0].product.price).toBeUndefined();
    expect(shared.body.items[0].product.id).toBe(P_DRESS);
    catalog.seed({ id: P_GONE, listed: true, currentPrice: { amount: 50_000n, currency: "EGP" }, skuIds: [], summary: summary(P_GONE, "قميص") });
  });

  it("rejects malformed tokens with 400 and rate-limits enumeration to 20/min per IP", async () => {
    const h2 = await createWishlistHarness();
    try {
      expect((await h2.http().get("/v1/shared/wishlists/short")).status).toBe(400);
      const codes: number[] = [];
      for (let i = 0; i < 20; i++) codes.push((await h2.http().get(`/v1/shared/wishlists/${"B".repeat(22)}`)).status);
      // one request above was already counted (the 400)
      expect(codes.slice(0, 19)).toEqual(Array(19).fill(404));
      expect(codes[19]).toBe(429);
      h2.clock.advance(61_000);
      expect((await h2.http().get(`/v1/shared/wishlists/${"B".repeat(22)}`)).status).toBe(404);
    } finally {
      await h2.close();
    }
  });
});

describe("alerts (events only, nothing is sent)", () => {
  const alertsFor = (itemId: string | null, type: string) =>
    events.events.filter((e) => e.type === "wishlist.alert_due" && e.alert.itemId === itemId && e.alert.alertType === type);

  it("emits verified price drops once, never for a price rise, and ignores unknown signal kinds", async () => {
    const l = await mk(a.token);
    const it = await addItem(a.token, l.id, { product_id: P_DRESS, sku_pref: SKU_M });
    const id = it.body.id as string;
    const drop = {
      kind: "verified_price_drop",
      event_id: "evt-1",
      product_id: P_DRESS,
      claim_id: "claim-1",
      new_price: egp("99900"),
    };
    expect(await signals.execute(drop)).toEqual({ kind: "handled", emitted: expect.any(Number) });
    await signals.execute(drop); // replay
    expect(alertsFor(id, "price_drop_verified")).toHaveLength(1);
    await signals.execute({ ...drop, event_id: "evt-2", claim_id: "claim-2", new_price: egp("200000") });
    expect(alertsFor(id, "price_drop_verified")).toHaveLength(1);
    expect(await signals.execute({ kind: "plain_price_cut", event_id: "x", product_id: P_DRESS })).toEqual({ kind: "invalid" });
  });

  it("emits low stock at 3 or fewer (not 0) and back in size for the preferred size", async () => {
    const l = await mk(a.token);
    const it = await addItem(a.token, l.id, { product_id: P_DRESS, sku_pref: SKU_L });
    const id = it.body.id as string;
    const stock = (n: number, sku = SKU_L, e = `s-${n}-${sku}`) =>
      signals.execute({ kind: "stock_level", event_id: e, product_id: P_DRESS, sku_id: sku, available: n });
    await stock(4);
    await stock(0);
    await stock(2, SKU_M);
    expect(alertsFor(id, "low_stock")).toHaveLength(0);
    await stock(3);
    await stock(3);
    expect(alertsFor(id, "low_stock")).toHaveLength(1);
    await signals.execute({ kind: "back_in_size", event_id: "b1", product_id: P_DRESS, sku_id: SKU_M });
    expect(alertsFor(id, "back_in_size")).toHaveLength(0);
    await signals.execute({ kind: "back_in_size", event_id: "b2", product_id: P_DRESS, sku_id: SKU_L });
    expect(alertsFor(id, "back_in_size")).toHaveLength(1);
  });

  it("emits date alerts at 7 and 1 days, once each", async () => {
    const s = await login(h, "+201001230031");
    // clock is not at the original start any more; derive the Cairo date from it
    const day = (offset: number) =>
      new Date(h.clock.nowMs() + 2 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);
    const l = await mk(s.accessToken, { intent: "birthday", title: "B-day", target_date: day(7) });
    const mine = () =>
      events.events.filter((e) => e.type === "wishlist.alert_due" && e.alert.wishlistId === l.id);
    await dateJob.execute();
    await dateJob.execute();
    expect(mine()).toHaveLength(1);
    h.clock.advance(5 * 86_400_000);
    await dateJob.execute(); // 2 days away
    expect(mine()).toHaveLength(1);
    h.clock.advance(86_400_000);
    await dateJob.execute(); // 1 day away
    await dateJob.execute();
    const got = mine().map((e) => (e.type === "wishlist.alert_due" ? e.alert.daysBefore : null));
    expect(got).toEqual([7, 1]);
  });

  it("carries no title, nickname or amount in event payloads", async () => {
    const dump = JSON.stringify(events.events, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    expect(dump).not.toContain("Sara");
    expect(dump).not.toContain("My list");
  });
});

// ---- Negative authorization (A2.10) ------------------------------------------------------------

interface Route {
  readonly name: string;
  readonly kind: "self" | "resource" | "public";
  readonly send: (token: string | null, listId: string, itemId: string) => Test;
  readonly okStatus: number;
}
const withAuth = (t: Test, token: string | null): Test => (token === null ? t : t.set(bearer(token)));

const ROUTES: readonly Route[] = [
  { name: "GET /v1/me/wishlists", kind: "self", okStatus: 200, send: (t) => withAuth(h.http().get("/v1/me/wishlists"), t) },
  {
    name: "POST /v1/me/wishlists",
    kind: "self",
    okStatus: 201,
    send: (t) => withAuth(h.http().post("/v1/me/wishlists"), t).send({ intent: "need", title: "x" }),
  },
  {
    name: "GET /v1/me/wishlists/{id}",
    kind: "resource",
    okStatus: 200,
    send: (t, l) => withAuth(h.http().get(`/v1/me/wishlists/${l}`), t),
  },
  {
    name: "PATCH /v1/me/wishlists/{id}",
    kind: "resource",
    okStatus: 200,
    send: (t, l) => withAuth(h.http().patch(`/v1/me/wishlists/${l}`), t).set("If-Match", "*").send({ title: "y" }),
  },
  {
    name: "POST /v1/wishlists/{id}/items",
    kind: "resource",
    okStatus: 201,
    send: (t, l) => withAuth(h.http().post(`/v1/wishlists/${l}/items`), t).send({ product_id: P_DRESS }),
  },
  {
    name: "DELETE /v1/wishlists/{id}/items/{itemId}",
    kind: "resource",
    okStatus: 204,
    send: (t, l, i) => withAuth(h.http().delete(`/v1/wishlists/${l}/items/${i}`), t),
  },
  {
    name: "POST /v1/me/wishlists/{id}/share",
    kind: "resource",
    okStatus: 201,
    send: (t, l) => withAuth(h.http().post(`/v1/me/wishlists/${l}/share`), t).send({}),
  },
  {
    name: "DELETE /v1/me/wishlists/{id}/share",
    kind: "resource",
    okStatus: 204,
    send: (t, l) => withAuth(h.http().delete(`/v1/me/wishlists/${l}/share`), t),
  },
  {
    name: "DELETE /v1/me/wishlists/{id}",
    kind: "resource",
    okStatus: 204,
    send: (t, l) => withAuth(h.http().delete(`/v1/me/wishlists/${l}`), t),
  },
  {
    name: "GET /v1/shared/wishlists/{token}",
    kind: "public",
    okStatus: 404, // an unknown token is the only state reachable without a prepared list
    send: () => h.http().get(`/v1/shared/wishlists/${"C".repeat(22)}`),
  },
];

describe("negative authorization", () => {
  const protectedRoutes = ROUTES.filter((r) => r.kind !== "public");
  const objectRoutes = ROUTES.filter((r) => r.kind === "resource");

  afterEach(async () => {
    h.clock.advance(61_000); // fresh rate-limit windows for the cleanup calls
    a = { ...a, token: await mint(a, "a") };
    const page = await h.http().get("/v1/me/wishlists").query({ limit: 50 }).set(bearer(a.token));
    for (const w of (page.body.items ?? []) as { id: string }[]) {
      await h.http().delete(`/v1/me/wishlists/${w.id}`).set(bearer(a.token));
    }
  });

  async function fresh() {
    const l = await mk(a.token);
    const i = await addItem(a.token, l.id, { product_id: P_SHOES });
    return { listId: l.id, itemId: i.body.id as string };
  }

  it.each(protectedRoutes.map((r) => r.name))("%s -> 401 unauthenticated and for a bad token", async (name) => {
    const r = ROUTES.find((x) => x.name === name);
    if (r === undefined) throw new Error("unreachable");
    const { listId, itemId } = await fresh();
    expect((await r.send(null, listId, itemId)).status).toBe(401);
    expect((await r.send("not-a-token", listId, itemId)).status).toBe(401);
  });

  it.each(protectedRoutes.map((r) => r.name))("%s -> 401 for a seller_api token", async (name) => {
    const r = ROUTES.find((x) => x.name === name);
    if (r === undefined) throw new Error("unreachable");
    const { listId, itemId } = await fresh();
    const authn = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false }) as unknown as {
      issue(c: unknown): Promise<string>;
    };
    const token = await authn.issue(
      buildAccessClaims({
        issuer: h.config.tokenIssuer,
        userId: a.userId,
        audience: "seller_api",
        sessionId: a.sessionId,
        jti: `jti-wl-${name}`,
        amr: ["otp_sms"],
        nowMs: h.clock.nowMs(),
      }),
    );
    expect((await r.send(token, listId, itemId)).status).toBe(401);
  });

  it.each(protectedRoutes.map((r) => r.name))("%s -> 403 for a suspended subject", async (name) => {
    const r = ROUTES.find((x) => x.name === name);
    if (r === undefined) throw new Error("unreachable");
    const { listId, itemId } = await fresh();
    const authn = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false });
    const original = authn.authenticate.bind(authn);
    authn.authenticate = async (t, n) => {
      const p = await original(t, n);
      return p === null ? null : { ...p, actor: { ...p.actor, status: "suspended" } };
    };
    try {
      const res = await r.send(a.token, listId, itemId);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("account_not_active");
    } finally {
      authn.authenticate = original;
    }
  });

  it.each(objectRoutes.map((r) => r.name))("%s -> 403 for an actor without the shopper grant", async (name) => {
    const r = ROUTES.find((x) => x.name === name);
    if (r === undefined) throw new Error("unreachable");
    const { listId, itemId } = await fresh();
    const authn = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false });
    const original = authn.authenticate.bind(authn);
    authn.authenticate = async (t, n) => {
      const p = await original(t, n);
      return p === null
        ? null
        : { ...p, actor: { ...p.actor, grants: [{ kind: "courier" as const, hubId: "hub-1" }] } };
    };
    try {
      expect((await r.send(a.token, listId, itemId)).status).toBe(403);
    } finally {
      authn.authenticate = original;
    }
  });

  it.each(objectRoutes.map((r) => r.name))("%s -> 404 for another user's list, identical to a missing one, no side effect", async (name) => {
    const r = ROUTES.find((x) => x.name === name);
    if (r === undefined) throw new Error("unreachable");
    const { listId, itemId } = await fresh();
    const foreign = await r.send(b.token, listId, itemId);
    const missing = await r.send(b.token, MISSING, itemId);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    const { request_id: _x, ...f } = foreign.body as Record<string, unknown>;
    const { request_id: _y, ...m } = missing.body as Record<string, unknown>;
    expect(f).toEqual(m);
    // The owner's list is untouched.
    const still = await h.http().get(`/v1/me/wishlists/${listId}`).set(bearer(a.token));
    expect(still.status).toBe(200);
    expect(still.body.items).toHaveLength(1);
    expect(still.body.visibility).toBe("private");
    expect(still.body.title).toBe("My list");
  });

  it.each(ROUTES.map((r) => r.name))("%s -> succeeds for the owner", async (name) => {
    const r = ROUTES.find((x) => x.name === name);
    if (r === undefined) throw new Error("unreachable");
    const { listId, itemId } = await fresh();
    const res = await r.send(a.token, listId, itemId);
    expect(res.status, JSON.stringify(res.body)).toBe(r.okStatus);
  });

  it("an item id from another list of the same owner is 404", async () => {
    const one = await fresh();
    const two = await fresh();
    const res = await h.http().delete(`/v1/wishlists/${one.listId}/items/${two.itemId}`).set(bearer(a.token));
    expect(res.status).toBe(404);
  });

  it("list is scoped to the caller", async () => {
    const mine = await mk(a.token, { intent: "custom", title: "only-mine-unique" });
    const theirs = await h.http().get("/v1/me/wishlists").query({ limit: 50 }).set(bearer(b.token));
    expect((theirs.body.items as { id: string }[]).some((w) => w.id === mine.id)).toBe(false);
  });
});

describe("limits", () => {
  it("caps lists per user and items per list", async () => {
    const s = await login(h, "+201001230077");
    for (let i = 0; i < 50; i++) await mk(s.accessToken, { intent: "custom", title: `t${i}` });
    const over = await h.http().post("/v1/me/wishlists").set(bearer(s.accessToken)).send({ intent: "custom", title: "51" });
    expect(over.status).toBe(422);
    expect(over.body.code).toBe("wishlist_limit_reached");
  }, 60_000);
});
