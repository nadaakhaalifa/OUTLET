import { buildAccessClaims } from "@outlet/auth-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTHENTICATOR, type Authenticator } from "../../platform";
import { IDEM_KEY_1 } from "../../test/harness";
import { id as seedId } from "./adapters/dev-seed";
import type { InMemoryStoreActivityFeed } from "./adapters/in-memory";
import {
  APPLY_SELLER_KYC_EVENT,
  CHANGE_STORE_STATUS,
  STORE_ACTIVITY_FEED,
} from "./adapters/tokens";
import type { ApplySellerKycEvent, ChangeStoreStatus } from "./application/seller-lifecycle";
import { createStoresHarness, type StoresHarness } from "./test/harness";
import { makeStore, uuid } from "./test/fixtures";

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const S = (n: number) => seedId(n);
const MISSING = "0192f3a4-5b6c-7d8e-9f01-0000000000ff";

interface Session {
  readonly token: string;
  readonly userId: string;
  readonly sessionId: string;
}

let h: StoresHarness;
let a: Session;
let b: Session;
let feed: InMemoryStoreActivityFeed;
let changeStatus: ChangeStoreStatus;
let applyKyc: ApplySellerKycEvent;

beforeAll(async () => {
  h = await createStoresHarness();
  const la = await h.loginAs("+201001110001");
  const lb = await h.loginAs("+201001110002");
  a = { token: la.accessToken, userId: la.userId, sessionId: la.sessionId };
  b = { token: lb.accessToken, userId: lb.userId, sessionId: lb.sessionId };
  feed = h.app.get<InMemoryStoreActivityFeed>(STORE_ACTIVITY_FEED, { strict: false });
  changeStatus = h.app.get<ChangeStoreStatus>(CHANGE_STORE_STATUS, { strict: false });
  applyKyc = h.app.get<ApplySellerKycEvent>(APPLY_SELLER_KYC_EVENT, { strict: false });
});
afterAll(async () => h.close());

async function putFavorites(s: Session, ids: readonly string[], ifMatch?: string, extra: Record<string, string> = {}) {
  let etag = ifMatch;
  if (etag === undefined) {
    const cur = await h.http().get("/v1/me/favorite-stores").set(bearer(s.token));
    etag = String(cur.headers["etag"]);
  }
  return h
    .http()
    .put("/v1/me/favorite-stores")
    .set(bearer(s.token))
    .set("If-Match", etag)
    .set(extra)
    .send({ store_ids: ids });
}

describe("directory", () => {
  it("local shows only visible local stores, including one on vacation", async () => {
    const r = await h.http().get("/v1/stores?world=local").set(bearer(a.token));
    expect(r.status).toBe(200);
    const ids = r.body.items.map((i: { id: string }) => i.id);
    expect(ids.sort()).toEqual([S(1), S(2), S(3), S(6)].sort());
    expect(r.body.page).toEqual({ next_cursor: null, has_more: false });
    expect(r.body.hint).toBeUndefined();
  });

  it("never lists suspended, draft, seller-suspended or identity-less stores in any world", async () => {
    const r = await h.http().get("/v1/stores?world=everything&limit=50").set(bearer(a.token));
    const ids: string[] = r.body.items.map((i: { id: string }) => i.id);
    for (const hidden of [7, 8, 9, 10]) expect(ids).not.toContain(S(hidden));
    expect(ids.length).toBe(6);
  });

  it("global shows only global visible stores", async () => {
    const r = await h.http().get("/v1/stores?world=global").set(bearer(a.token));
    expect(r.body.items.map((i: { id: string }) => i.id).sort()).toEqual([S(4), S(5)].sort());
  });

  it("sorts trending by default, ties by id, and puts nulls last for discount", async () => {
    const t = await h.http().get("/v1/stores?world=everything").set(bearer(a.token));
    expect(t.body.items[0].id).toBe(S(1));
    const d = await h.http().get("/v1/stores?world=everything&sort=biggest_verified_discount").set(bearer(a.token));
    expect(d.body.items[0].id).toBe(S(4));
    expect(d.body.items[d.body.items.length - 1].max_verified_discount_pct).toBeNull();
    const n = await h.http().get("/v1/stores?world=everything&sort=name").set(bearer(a.token));
    const names: string[] = n.body.items.map((i: { name: { ar: string } }) => i.name.ar);
    expect(names).toEqual([...names].sort());
  });

  it("paginates with an opaque cursor without repeats and ends with has_more=false", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const url: string = `/v1/stores?world=everything&sort=fastest_delivery&limit=2${cursor === null ? "" : `&cursor=${cursor}`}`;
      const r = await h.http().get(url).set(bearer(a.token));
      expect(r.status).toBe(200);
      seen.push(...r.body.items.map((x: { id: string }) => x.id));
      if (!r.body.page.has_more) {
        expect(r.body.page.next_cursor).toBeNull();
        break;
      }
      cursor = r.body.page.next_cursor;
      expect(typeof cursor).toBe("string");
    }
    expect(new Set(seen).size).toBe(6);
    expect(seen.length).toBe(6);
  });

  it("rejects a cursor from another world or sort, garbage and bad params with 400", async () => {
    const page = await h.http().get("/v1/stores?world=everything&limit=1").set(bearer(a.token));
    const cursor = page.body.page.next_cursor as string;
    const other = await h.http().get(`/v1/stores?world=local&cursor=${cursor}`).set(bearer(a.token));
    expect(other.status).toBe(400);
    expect(other.body.code).toBe("invalid_cursor");
    const sorted = await h.http().get(`/v1/stores?world=everything&sort=name&cursor=${cursor}`).set(bearer(a.token));
    expect(sorted.status).toBe(400);
    for (const q of ["world=mars", "world=local&limit=51", "world=local&limit=0", "world=local&sort=random", "", "world=local&x=1", "world=local&cursor=!!!"]) {
      const r = await h.http().get(`/v1/stores?${q}`).set(bearer(a.token));
      expect(r.status, q).toBe(400);
    }
  });

  it("exposes only verified-style data: null discount and rating when there is no evidence", async () => {
    const r = await h.http().get("/v1/stores?world=local").set(bearer(a.token));
    const oasis = r.body.items.find((i: { id: string }) => i.id === S(3));
    expect(oasis.max_verified_discount_pct).toBeNull();
    expect(oasis.rating).toBeNull();
    expect(oasis.rating_count).toBe(0);
    const nile = r.body.items.find((i: { id: string }) => i.id === S(1));
    expect(nile.max_verified_discount_pct).toBe(40);
    expect(nile.name).toEqual({ ar: "نايل أوتلت", en: "Nile Outlet" });
    expect(Object.keys(nile).sort()).toEqual(
      [
        "follower_count", "id", "is_favorite", "kind", "live_drop", "max_verified_discount_pct", "name", "rating",
        "rating_count", "slug", "verified_badge",
      ].sort(),
    );
  });
});

describe("store page", () => {
  it("returns legal identity, threshold and status, with ETag and 304", async () => {
    const r = await h.http().get(`/v1/stores/${S(1)}`).set(bearer(a.token));
    expect(r.status).toBe(200);
    expect(r.body.legal_identity).toMatchObject({ commercial_register_no: "SYN-CR-1", tax_id: "SYN-TAX-1", governorate: "القاهرة" });
    expect(r.body.free_delivery_threshold).toEqual({ amount: "200000", currency: "EGP" });
    expect(r.body.status).toBe("active");
    expect(r.body.health_badge).toBe("good");
    const again = await h.http().get(`/v1/stores/${S(1)}`).set(bearer(a.token)).set("If-None-Match", String(r.headers["etag"]));
    expect(again.status).toBe(304);
  });

  it("reports a paused store as vacation", async () => {
    const r = await h.http().get(`/v1/stores/${S(6)}`).set(bearer(a.token));
    expect(r.body.status).toBe("vacation");
  });

  it("answers 404 identically for suspended, seller-suspended, draft, no-identity and missing", async () => {
    const bodies = [];
    for (const n of [7, 8, 9, 10]) {
      const r = await h.http().get(`/v1/stores/${S(n)}`).set(bearer(a.token));
      expect(r.status).toBe(404);
      bodies.push(r.body.code);
    }
    const missing = await h.http().get(`/v1/stores/${MISSING}`).set(bearer(a.token));
    expect(missing.status).toBe(404);
    expect(new Set([...bodies, missing.body.code]).size).toBe(1);
    expect((await h.http().get("/v1/stores/not-a-uuid").set(bearer(a.token))).status).toBe(400);
  });
});

describe("favourite stores", () => {
  it("starts empty, My Stores shows the widen hint, then follows the saved order", async () => {
    const empty = await h.http().get("/v1/me/favorite-stores").set(bearer(b.token));
    expect(empty.body).toEqual({ stores: [] });
    const hint = await h.http().get("/v1/stores?world=my_stores").set(bearer(b.token));
    expect(hint.body.items).toEqual([]);
    expect(hint.body.hint).toEqual({ kind: "widen_world", suggested_world: "everything" });

    const put = await putFavorites(b, [S(5), S(1), S(4)]);
    expect(put.status).toBe(200);
    expect(put.body.stores.map((s: { id: string }) => s.id)).toEqual([S(5), S(1), S(4)]);
    expect(put.body.stores.every((s: { is_favorite: boolean }) => s.is_favorite)).toBe(true);
    const mine = await h.http().get("/v1/stores?world=my_stores").set(bearer(b.token));
    expect(mine.body.items.map((s: { id: string }) => s.id)).toEqual([S(5), S(1), S(4)]);
    expect(mine.body.hint).toBeUndefined();
    const sorted = await h.http().get("/v1/stores?world=my_stores&sort=name").set(bearer(b.token));
    expect(sorted.body.items.length).toBe(3);
    // follower_count is derived from real favourites
    const nile = await h.http().get(`/v1/stores/${S(1)}`).set(bearer(a.token));
    expect(nile.body.follower_count).toBe(1);
    expect(nile.body.is_favorite).toBe(false);
    await putFavorites(b, []);
  });

  it("requires If-Match (428), rejects a stale one (412), accepts * only on an empty list", async () => {
    const none = await h.http().put("/v1/me/favorite-stores").set(bearer(a.token)).send({ store_ids: [] });
    expect(none.status).toBe(428);
    const star = await h.http().put("/v1/me/favorite-stores").set(bearer(a.token)).set("If-Match", "*").send({ store_ids: [S(1)] });
    expect(star.status).toBe(200);
    const starAgain = await h.http().put("/v1/me/favorite-stores").set(bearer(a.token)).set("If-Match", "*").send({ store_ids: [S(2)] });
    expect(starAgain.status).toBe(412);
    const stale = await h.http().put("/v1/me/favorite-stores").set(bearer(a.token)).set("If-Match", '"deadbeef"').send({ store_ids: [S(2)] });
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe("precondition_failed");
  });

  it("a second device with an old ETag loses (412) and the list is unchanged", async () => {
    const before = await h.http().get("/v1/me/favorite-stores").set(bearer(a.token));
    const oldTag = String(before.headers["etag"]);
    expect((await putFavorites(a, [S(2), S(1)])).status).toBe(200);
    const lost = await putFavorites(a, [S(3)], oldTag);
    expect(lost.status).toBe(412);
    const after = await h.http().get("/v1/me/favorite-stores").set(bearer(a.token));
    expect(after.body.stores.map((s: { id: string }) => s.id)).toEqual([S(2), S(1)]);
  });

  it("rejects duplicates, unknown, suspended, draft and malformed bodies without leaking which", async () => {
    const dup = await putFavorites(a, [S(1), S(1)]);
    expect(dup.status).toBe(422);
    expect(dup.body.code).toBe("duplicate_store");
    const codes = new Set<string>();
    for (const n of [7, 8, 9, 10]) {
      const r = await putFavorites(a, [S(n)]);
      expect(r.status).toBe(422);
      codes.add(r.body.code);
    }
    const unknown = await putFavorites(a, [MISSING]);
    codes.add(unknown.body.code);
    expect([...codes]).toEqual(["unknown_store"]);
    const cur = await h.http().get("/v1/me/favorite-stores").set(bearer(a.token));
    const tag = String(cur.headers["etag"]);
    for (const body of [{}, { store_ids: "x" }, { store_ids: ["nope"] }, { store_ids: [], extra: 1 }]) {
      const r = await h.http().put("/v1/me/favorite-stores").set(bearer(a.token)).set("If-Match", tag).send(body);
      expect(r.status).toBe(400);
    }
  });

  it("replays an idempotent PUT without re-running it", async () => {
    const cur = await h.http().get("/v1/me/favorite-stores").set(bearer(b.token));
    const tag = String(cur.headers["etag"]);
    const first = await putFavorites(b, [S(4)], tag, { "Idempotency-Key": IDEM_KEY_1 });
    expect(first.status).toBe(200);
    const second = await putFavorites(b, [S(4)], tag, { "Idempotency-Key": IDEM_KEY_1 });
    expect(second.status).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    await putFavorites(b, []);
  });

  it("hides a suspended favourite with an explanation and restores it on reinstatement", async () => {
    await putFavorites(a, [S(1), S(2), S(4)]);
    await changeStatus.execute(S(2), "SUSPEND");
    const r = await h.http().get("/v1/me/favorite-stores").set(bearer(a.token));
    expect(r.body.stores.map((s: { id: string }) => s.id)).toEqual([S(1), S(4)]);
    expect(r.body.hidden).toEqual([
      { store_id: S(2), reason: "suspended", message: expect.objectContaining({ ar: expect.any(String), en: expect.any(String) }) },
    ]);
    expect(JSON.stringify(r.body.hidden)).not.toContain("Delta");
    const counts = await h.http().get("/v1/me/favorite-stores/new-counts").set(bearer(a.token));
    expect(counts.body.counts.map((c: { store_id: string }) => c.store_id)).toEqual([S(1), S(4)]);
    await changeStatus.execute(S(2), "REINSTATE");
    const back = await h.http().get("/v1/me/favorite-stores").set(bearer(a.token));
    expect(back.body.stores.map((s: { id: string }) => s.id)).toEqual([S(1), S(2), S(4)]);
    expect(back.body.hidden).toBeUndefined();
  });

  it("hides every store of a seller whose KYC is suspended and restores them on REINSTATE", async () => {
    const sellerOfStore1 = S(9000 + 1);
    await putFavorites(a, [S(1)]);
    const ok = { documentsValid: true, sanctionsClear: true, signatoryAdult21: true };
    await applyKyc.execute(sellerOfStore1, "SUSPEND", ok);
    expect((await h.http().get(`/v1/stores/${S(1)}`).set(bearer(a.token))).status).toBe(404);
    const list = await h.http().get("/v1/stores?world=everything").set(bearer(a.token));
    expect(list.body.items.map((i: { id: string }) => i.id)).not.toContain(S(1));
    const favs = await h.http().get("/v1/me/favorite-stores").set(bearer(a.token));
    expect(favs.body.hidden[0].reason).toBe("suspended");
    await applyKyc.execute(sellerOfStore1, "REINSTATE", ok);
    expect((await h.http().get(`/v1/stores/${S(1)}`).set(bearer(a.token))).status).toBe(200);
  });
});

describe("new since last visit", () => {
  it("counts activity after last_seen_at, resets on seen, and seen is idempotent", async () => {
    await putFavorites(b, [S(1), S(4)]);
    h.clock.advance(60_000);
    feed.record(S(1), h.clock.nowMs() - 1_000);
    feed.record(S(1), h.clock.nowMs() - 500);
    feed.record(S(4), h.clock.nowMs() - 100);
    const before = await h.http().get("/v1/me/favorite-stores/new-counts").set(bearer(b.token));
    expect(before.body.counts).toEqual([
      { store_id: S(1), new_since_last_visit: 2 },
      { store_id: S(4), new_since_last_visit: 1 },
    ]);
    h.clock.advance(1_000);
    const seen = await h.http().post(`/v1/me/favorite-stores/${S(1)}/seen`).set(bearer(b.token));
    expect(seen.status).toBe(204);
    expect(seen.text).toBe("");
    const again = await h.http().post(`/v1/me/favorite-stores/${S(1)}/seen`).set(bearer(b.token));
    expect(again.status).toBe(204);
    const after = await h.http().get("/v1/me/favorite-stores/new-counts").set(bearer(b.token));
    expect(after.body.counts).toEqual([
      { store_id: S(1), new_since_last_visit: 0 },
      { store_id: S(4), new_since_last_visit: 1 },
    ]);
    await putFavorites(b, []);
  });

  it("a new favourite starts at zero and a retained favourite keeps its counter across PUT", async () => {
    await putFavorites(b, [S(1)]);
    h.clock.advance(10_000);
    feed.record(S(1), h.clock.nowMs());
    h.clock.advance(1_000);
    await putFavorites(b, [S(4), S(1)]);
    const r = await h.http().get("/v1/me/favorite-stores/new-counts").set(bearer(b.token));
    expect(r.body.counts).toEqual([
      { store_id: S(4), new_since_last_visit: 0 },
      { store_id: S(1), new_since_last_visit: 1 },
    ]);
    await putFavorites(b, []);
  });
});

describe("negative authorization", () => {
  const routes: readonly { name: string; send: (token: string | null) => ReturnType<ReturnType<typeof h.http>["get"]> }[] = [
    { name: "GET /v1/stores", send: (t) => withAuth(h.http().get("/v1/stores?world=local"), t) },
    { name: "GET /v1/stores/{id}", send: (t) => withAuth(h.http().get(`/v1/stores/${S(1)}`), t) },
    { name: "GET /v1/me/favorite-stores", send: (t) => withAuth(h.http().get("/v1/me/favorite-stores"), t) },
    {
      name: "PUT /v1/me/favorite-stores",
      send: (t) => withAuth(h.http().put("/v1/me/favorite-stores").set("If-Match", "*").send({ store_ids: [] }), t),
    },
    { name: "GET /v1/me/favorite-stores/new-counts", send: (t) => withAuth(h.http().get("/v1/me/favorite-stores/new-counts"), t) },
    { name: "POST /v1/me/favorite-stores/{id}/seen", send: (t) => withAuth(h.http().post(`/v1/me/favorite-stores/${S(1)}/seen`), t) },
  ];

  function withAuth<T extends { set(h: Record<string, string>): T }>(req: T, token: string | null): T {
    return token === null ? req : req.set(bearer(token));
  }

  it.each(routes.map((r) => [r.name]))("%s without credentials is 401 with no body detail", async (name) => {
    const route = routes.find((r) => r.name === name);
    if (route === undefined) throw new Error("unreachable");
    const r = await route.send(null);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("unauthenticated");
    expect(Object.keys(r.body).sort()).toEqual(["code", "request_id", "status", "title", "type"].sort());
  });

  it.each(routes.map((r) => [r.name]))("%s with a seller_api token is 401 and a suspended subject is 403", async (name) => {
    const route = routes.find((r) => r.name === name);
    if (route === undefined) throw new Error("unreachable");
    const authn = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false });
    const issuer = authn as unknown as { issue(claims: unknown): Promise<string> };
    const claims = buildAccessClaims({
      issuer: h.config.tokenIssuer,
      userId: a.userId,
      audience: "seller_api",
      sessionId: a.sessionId,
      jti: `jti-stores-${name}`,
      amr: ["otp_sms"],
      nowMs: h.clock.nowMs(),
    });
    const sellerToken = await issuer.issue(claims);
    expect((await route.send(sellerToken)).status).toBe(401);

    const original = authn.authenticate.bind(authn);
    authn.authenticate = async (t, n) => {
      const p = await original(t, n);
      return p === null ? null : { ...p, actor: { ...p.actor, status: "suspended" } };
    };
    try {
      const r = await route.send(a.token);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("account_not_active");
    } finally {
      authn.authenticate = original;
    }
  });

  it("another user's favourites are unreachable: seen on a store only the other user favourited is 404", async () => {
    await putFavorites(a, [S(1)]);
    await putFavorites(b, [S(4)]);
    const crossed = await h.http().post(`/v1/me/favorite-stores/${S(1)}/seen`).set(bearer(b.token));
    expect(crossed.status).toBe(404);
    const own = await h.http().post(`/v1/me/favorite-stores/${S(4)}/seen`).set(bearer(b.token));
    expect(own.status).toBe(204);
    const bList = await h.http().get("/v1/me/favorite-stores").set(bearer(b.token));
    expect(bList.body.stores.map((s: { id: string }) => s.id)).toEqual([S(4)]);
    // a store b never favourited, a suspended one and a missing one all look the same
    const bodies = new Set<string>();
    for (const sid of [S(2), S(7), MISSING]) {
      const r = await h.http().post(`/v1/me/favorite-stores/${sid}/seen`).set(bearer(b.token));
      expect(r.status).toBe(404);
      bodies.add(JSON.stringify({ ...r.body, request_id: "x" }));
    }
    expect(bodies.size).toBe(1);
    // and the failed attempt did not change a's data
    const aCounts = await h.http().get("/v1/me/favorite-stores/new-counts").set(bearer(a.token));
    expect(aCounts.body.counts.map((c: { store_id: string }) => c.store_id)).toEqual([S(1)]);
    await putFavorites(a, []);
    await putFavorites(b, []);
  });
});

describe("cap of 30", () => {
  it("accepts 30 and rejects 31 at the boundary", async () => {
    const seed = Array.from({ length: 35 }, (_, i) => makeStore(i + 1, { slug: `bulk-${i + 1}` }));
    const big = await createStoresHarness({ seed });
    try {
      const l = await big.loginAs("+201001110009");
      const t = l.accessToken;
      const tag0 = String((await big.http().get("/v1/me/favorite-stores").set(bearer(t))).headers["etag"]);
      const thirty = Array.from({ length: 30 }, (_, i) => uuid(i + 1));
      const ok = await big.http().put("/v1/me/favorite-stores").set(bearer(t)).set("If-Match", tag0).send({ store_ids: thirty });
      expect(ok.status).toBe(200);
      expect(ok.body.stores.length).toBe(30);
      const tag1 = String(ok.headers["etag"]);
      const tooMany = await big
        .http()
        .put("/v1/me/favorite-stores")
        .set(bearer(t))
        .set("If-Match", tag1)
        .send({ store_ids: Array.from({ length: 31 }, (_, i) => uuid(i + 1)) });
      // OpenAPI caps store_ids at maxItems 30, so 31 is a boundary (Zod) 400; the domain 422 is defence in depth
      expect(tooMany.status).toBe(400);
      const check = await big.http().get("/v1/me/favorite-stores").set(bearer(t));
      expect(check.body.stores.length).toBe(30);
    } finally {
      await big.close();
    }
  });
});
