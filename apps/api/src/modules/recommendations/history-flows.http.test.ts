import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDEM, P, S, TOKENS, USERS, bearer, cand, createHarness, DAY, type Harness } from "./test/harness";

let h: Harness;
let seq = 0;
const idemHeader = (): Record<string, string> => ({ "Idempotency-Key": IDEM(1000 + ++seq) });

beforeAll(async () => {
  h = await createHarness();
  h.addProduct(cand(1, 1));
  h.addProduct(cand(2, 2));
}, 60_000);
afterAll(async () => {
  await h.close();
});

const tick = (): void => h.clock.advance(61_000);
const get = (path: string, token: string) => {
  tick();
  return h.http().get(path).set(bearer(token));
};
const call = (method: "post" | "patch" | "delete", path: string, token: string, body?: unknown, headers = idemHeader()) => {
  tick();
  const r = h.http()[method](path).set(bearer(token)).set(headers);
  return body === undefined ? r : r.send(body as object);
};

describe("history API", () => {
  it("views feed history and recently viewed; list is own data, newest first, paged", async () => {
    for (const p of [1, 2, 1]) {
      expect((await call("post", "/v1/me/recently-viewed", TOKENS.a, { product_id: P(p) }, {})).status).toBe(200);
      h.clock.advance(1000);
    }
    await h.record.execute({ userId: USERS.a, type: "searched", itemId: null, detail: "linen dress" });
    await h.record.execute({ userId: USERS.b, type: "searched", itemId: null, detail: "b secret" });
    const r = await get("/v1/me/history?limit=2", TOKENS.a);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.page.has_more).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("b secret");
    expect(JSON.stringify(r.body)).not.toContain(USERS.a);
    const next = await get(`/v1/me/history?limit=50&cursor=${r.body.page.next_cursor as string}`, TOKENS.a);
    expect(next.body.items.length).toBe(2);
    const only = await get("/v1/me/history?type=searched", TOKENS.a);
    expect(only.body.items.map((i: { detail: string }) => i.detail)).toEqual(["linen dress"]);
    const rv = await get("/v1/me/recently-viewed", TOKENS.a);
    expect(rv.body.items.map((i: { product_id: string }) => i.product_id)).toEqual([P(1), P(2)]);
  });

  it("validates query and cursor", async () => {
    expect((await get("/v1/me/history?type=bogus", TOKENS.a)).status).toBe(400);
    expect((await get("/v1/me/history?cursor=%%%", TOKENS.a)).status).toBe(400);
    expect((await get("/v1/me/history?limit=500", TOKENS.a)).status).toBe(400);
    expect((await call("post", "/v1/me/history/pause", TOKENS.a, { paused: "yes" })).status).toBe(400);
    expect((await call("patch", "/v1/me/settings", TOKENS.a, { personalization: true, budget: 5 })).status).toBe(400);
  });

  it("recording a view of an unknown product is 404", async () => {
    expect((await call("post", "/v1/me/recently-viewed", TOKENS.a, { product_id: P(999) }, {})).status).toBe(404);
  });

  it("pause stops recording and survives; resume records again", async () => {
    const p = await call("post", "/v1/me/history/pause", TOKENS.b, { paused: true });
    expect(p.status).toBe(200);
    expect(p.body.history_paused).toBe(true);
    await call("post", "/v1/me/recently-viewed", TOKENS.b, { product_id: P(1) }, {});
    const l = await get("/v1/me/history", TOKENS.b);
    expect(l.body.items.some((i: { type: string }) => i.type === "viewed")).toBe(false);
    expect(l.body.settings.history_paused).toBe(true);
    await call("post", "/v1/me/history/pause", TOKENS.b, { paused: false });
  });

  it("DELETE requires an Idempotency-Key, clears own data only, and replays the same response", async () => {
    tick();
    expect((await h.http().delete("/v1/me/history").set(bearer(TOKENS.a))).status).toBe(400);
    const key = idemHeader();
    const first = await call("delete", "/v1/me/history", TOKENS.a, undefined, key);
    expect(first.status).toBe(200);
    expect(first.body.deleted.events).toBeGreaterThan(0);
    expect(new Date(first.body.complete_by).getTime() - h.clock.nowMs()).toBeGreaterThan(23 * 3_600_000);
    const replay = await call("delete", "/v1/me/history", TOKENS.a, undefined, key);
    expect(replay.body.request_id).toBe(first.body.request_id);
    expect((await get("/v1/me/history", TOKENS.a)).body.items).toEqual([]);
    expect((await get("/v1/me/recently-viewed", TOKENS.a)).body.items).toEqual([]);
    expect((await h.history.listEvents(USERS.b, null, null, 10)).length).toBeGreaterThan(0);
  });

  it("the clear job completes within 24h and a rebuilt feature before the request is removed", async () => {
    h.consent.grant(USERS.a);
    const pending = await h.history.pendingClearForUser(USERS.a);
    expect(pending.length).toBeGreaterThan(0);
    await h.history.putFeatures(USERS.a, {
      features: { categoryAffinity: { dress: 5 }, storeAffinity: {}, builtAtMs: pending[0]!.requestedAtMs - 1 },
      modelVersion: "feat-v1",
    });
    h.clock.advance(2 * 3_600_000);
    const rep = await h.sweep.execute();
    expect(rep.completed).toBeGreaterThan(0);
    expect(rep.overdue).toBe(0);
    expect(await h.history.getFeatures(USERS.a)).toBeNull();
    expect(await h.history.pendingClearForUser(USERS.a)).toEqual([]);
  });

  it("settings and history are partitioned by token subject: user B cannot affect user A", async () => {
    await call("patch", "/v1/me/settings", TOKENS.b, { personalization: false });
    expect(await h.history.getSettings(USERS.a)).toEqual({ personalization: true, historyPaused: false });
    expect(await h.history.getSettings(USERS.b)).toMatchObject({ personalization: false });
    expect(DAY).toBeGreaterThan(0);
    expect(S(1)).toBeTruthy();
  });
});
