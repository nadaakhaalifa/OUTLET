import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStoresHarness, type StoresHarness } from "./test/harness";
import { createStoresPglite, type StoresPglite } from "./test/pglite-fixture";
import { makeStore } from "./test/fixtures";

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

let pg: StoresPglite;
let h: StoresHarness;
let token: string;
const live = makeStore(41, { slug: "pg-live" });
const hidden = makeStore(42, { slug: "pg-draft", status: "DRAFT", sellerKycState: "DRAFT" });

beforeAll(async () => {
  pg = await createStoresPglite();
  await pg.stores.save(live);
  await pg.stores.save(hidden);
  h = await createStoresHarness({ persistence: { runner: pg.runner, session: pg.session } });
  const l = await h.loginAs("+201001110031");
  token = l.accessToken;
  await pg.addUser(l.userId);
  pg.setSession({ userId: l.userId, role: "customer" });
});
afterAll(async () => {
  await h.close();
  await pg.close();
});

describe("stores module over Kysely + PGlite (RLS as app_user)", () => {
  it("lists only shopper-visible stores from Postgres", async () => {
    const r = await h.http().get("/v1/stores?world=everything").set(bearer(token));
    expect(r.status).toBe(200);
    const ids = r.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(hidden.id);
  });

  it("round-trips favourites and counts followers under the caller's identity", async () => {
    const cur = await h.http().get("/v1/me/favorite-stores").set(bearer(token));
    expect(cur.status).toBe(200);
    const put = await h
      .http()
      .put("/v1/me/favorite-stores")
      .set(bearer(token))
      .set("If-Match", String(cur.headers["etag"]))
      .send({ store_ids: [live.id] });
    expect(put.status).toBe(200);
    expect((await pg.favorites.followerCounts()).get(live.id)).toBe(1);
  });
});
