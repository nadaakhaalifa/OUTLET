import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/env";
import { MissingResalePortsError, ResaleLaneModule } from "./index";
import { IDEM, STORE_A, STORE_B, U, returnFacts } from "./test/fixtures";
import { TOKENS, bearer, createResaleHarness, type ResaleHarness } from "./test/harness";

let h: ResaleHarness;
let seq = 0;
const idem = (): Record<string, string> => ({ "Idempotency-Key": IDEM(++seq) });
const tick = (): void => h.clock.advance(61_000);
beforeEach(async () => {
  h = await createResaleHarness();
  h.returns.byId.set(returnFacts(1).returnId, returnFacts(1));
  h.consent.sellers.add(STORE_A);
});
afterEach(async () => {
  await h.close();
});

const body = (over: Record<string, unknown> = {}) => ({ return_id: returnFacts(1).returnId, grade: "B", photo_ids: ["p1", "p2"], price_piastres: "80000", ...over });
const create = (token: string | null, b: unknown = body()) => {
  tick();
  const r = h.http().post("/v1/hub/resale/listings").set(idem());
  return (token === null ? r : r.set(bearer(token))).send(b as object);
};

describe("hub listing", () => {
  it("operator lists a unit and a shopper sees it with no discount claim", async () => {
    const r = await create(TOKENS.opHub1);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ grade: "B", status: "LISTED", price_piastres: "80000" });
    tick();
    const one = await h.http().get(`/v1/resale/listings/${r.body.id as string}`).set(bearer(TOKENS.shopper));
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ condition: "open_box_returned", price_label: "launch_price", grade_label: { en: "Minor wear" } });
    const keys = Object.keys(one.body as object).join(",");
    expect(keys).not.toMatch(/original|reference|vrp|percent|discount|strike|was_/i);
    tick();
    const page = await h.http().get("/v1/resale/listings").set(bearer(TOKENS.shopper));
    expect(page.body.items).toHaveLength(1);
  });
  it("refuses with the documented reason and is 409 for a second listing of the unit", async () => {
    h.consent.sellers.clear();
    const a = await create(TOKENS.opHub1);
    expect(a.status).toBe(422);
    expect(a.body.code).toBe("seller_declined");
    h.consent.sellers.add(STORE_A);
    expect((await create(TOKENS.opHub1)).status).toBe(201);
    expect((await create(TOKENS.opHub1)).status).toBe(409);
  });
  it("validates the body strictly", async () => {
    expect((await create(TOKENS.opHub1, body({ grade: "C" }))).status).toBe(400);
    expect((await create(TOKENS.opHub1, body({ price_piastres: "0" }))).status).toBe(400);
    expect((await create(TOKENS.opHub1, body({ price_piastres: "12.5" }))).status).toBe(400);
    expect((await create(TOKENS.opHub1, body({ extra: 1 }))).status).toBe(400);
    tick();
    const noKey = await h.http().post("/v1/hub/resale/listings").set(bearer(TOKENS.opHub1)).send(body());
    expect(noKey.status).toBe(400);
  });
});

describe("authorization", () => {
  it("another hub's operator gets 404; roles without a hub grant get 403; bad audiences 401", async () => {
    expect((await create(TOKENS.opHub2)).status).toBe(404);
    expect(h.store.listings.size).toBe(0);
    expect((await create(TOKENS.adminSupport)).status).toBe(403);
    expect((await create(TOKENS.shopperOnAdminAud)).status).toBe(403);
    expect((await create(TOKENS.operatorOnBuyerAud)).status).toBe(401);
    expect((await create(null)).status).toBe(401);
  });
  it("browse routes need a shopper; an unknown or withdrawn listing is 404", async () => {
    tick();
    expect((await h.http().get("/v1/resale/listings")).status).toBe(401);
    expect((await h.http().get(`/v1/resale/listings/${U(9)}`).set(bearer(TOKENS.shopper))).status).toBe(404);
    const r = await create(TOKENS.opHub1);
    tick();
    const w = await h.http().post(`/v1/seller/stores/${STORE_A}/resale/listings/${r.body.id as string}/withdraw`).set(idem()).set(bearer(TOKENS.ownerA)).send({});
    expect(w.status).toBe(200);
    tick();
    expect((await h.http().get(`/v1/resale/listings/${r.body.id as string}`).set(bearer(TOKENS.shopper))).status).toBe(404);
  });
  it("seller routes: own store reads, other store is 404, support cannot withdraw (403)", async () => {
    const r = await create(TOKENS.opHub1);
    const id = r.body.id as string;
    tick();
    const own = await h.http().get(`/v1/seller/stores/${STORE_A}/resale/listings`).set(bearer(TOKENS.catalogA));
    expect(own.status).toBe(200);
    expect(own.body.items).toHaveLength(1);
    tick();
    expect((await h.http().get(`/v1/seller/stores/${STORE_A}/resale/listings`).set(bearer(TOKENS.ownerB))).status).toBe(404);
    tick();
    expect((await h.http().post(`/v1/seller/stores/${STORE_A}/resale/listings/${id}/withdraw`).set(idem()).set(bearer(TOKENS.ownerB)).send({})).status).toBe(404);
    tick();
    expect((await h.http().post(`/v1/seller/stores/${STORE_A}/resale/listings/${id}/withdraw`).set(idem()).set(bearer(TOKENS.supportA)).send({})).status).toBe(403);
    tick();
    // a listing addressed through another store's path is not found even for that store's owner
    expect((await h.http().post(`/v1/seller/stores/${STORE_B}/resale/listings/${id}/withdraw`).set(idem()).set(bearer(TOKENS.ownerB)).send({})).status).toBe(404);
    expect(h.store.listings.get(id)?.status).toBe("LISTED");
    tick();
    expect((await h.http().get(`/v1/seller/stores/${STORE_A}/resale/listings`)).status).toBe(401);
  });
});

describe("admin listings", () => {
  it("ops-style admin pages listings with keyset cursor; seller/shopper/other audience refused; bad cursor 400", async () => {
    expect((await create(TOKENS.opHub1)).status).toBe(201);
    tick();
    const ok = await h.http().get("/v1/admin/resale/listings?limit=1").set(bearer(TOKENS.adminOps));
    expect(ok.status).toBe(200);
    expect(ok.body.items).toHaveLength(1);
    expect(ok.body.items[0].price).toEqual({ amount_minor: "80000", currency: "EGP" });
    expect(ok.body.page.has_more).toBe(false);
    tick();
    expect((await h.http().get("/v1/admin/resale/listings").set(bearer(TOKENS.adminSupport))).status).toBe(403);
    expect((await h.http().get("/v1/admin/resale/listings").set(bearer(TOKENS.ownerA))).status).toBe(401);
    expect((await h.http().get("/v1/admin/resale/listings").set(bearer(TOKENS.shopperOnAdminAud))).status).toBe(403);
    expect((await h.http().get("/v1/admin/resale/listings")).status).toBe(401);
    expect((await h.http().get("/v1/admin/resale/listings?cursor=zzz").set(bearer(TOKENS.adminOps))).status).toBe(400);
  });
});

describe("module boot", () => {
  it("refuses to boot outside test mode without real ports", () => {
    expect(() => ResaleLaneModule.forRoot(loadConfig({ NODE_ENV: "development" }))).toThrow(MissingResalePortsError);
    expect(() => ResaleLaneModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
  });
});
