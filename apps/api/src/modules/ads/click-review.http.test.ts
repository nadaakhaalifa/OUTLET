import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDEM, STORE_A, TOKENS, U, bearer, createAdsHarness, type AdsHarness } from "./test/harness";

let h: AdsHarness;
let seq = 5000;
beforeAll(async () => {
  h = await createAdsHarness();
  const c = U(100);
  const p = U(700);
  await h.rt.store.insertCampaign(
    { id: c, storeId: STORE_A, name: "Q", status: "ACTIVE", dailyBudget: 50_000n, maxCpc: 1_000n, keywords: [], categories: [], startsAtMs: 0, endsAtMs: null, createdAtMs: 1, updatedAtMs: 1 },
    [{ campaignId: c, productId: p, bid: 500n, createdAtMs: 1 }],
  );
  const base = h.rt.clock.nowMs();
  for (let n = 1; n <= 3; n += 1) {
    await h.rt.store.billClick(
      { id: U(900 + n), tokenJti: `jti-q-${n}-xxxxxx`, campaignId: c, storeId: STORE_A, productId: p, impressionId: U(600), sessionHash: "s".repeat(64), valid: false, invalidReason: n === 3 ? "token_expired" : "bot", cost: 0n, dayKey: "2026-04-15", atMs: base - n * 1_000, postedEntryId: null, creditedBack: 0n },
      { dailyBudget: 50_000n },
      [],
    );
  }
}, 60_000);
afterAll(async () => {
  await h.close();
});

const idem = (): Record<string, string> => ({ "Idempotency-Key": IDEM(++seq) });
const get = (path: string, token: string | null) => {
  const r = h.http().get(path);
  return token === null ? r : r.set(bearer(token));
};
const post = (path: string, token: string | null, body: unknown, key = idem()) => {
  const r = h.http().post(path).set(key);
  return (token === null ? r : r.set(bearer(token))).send(body as object);
};

describe("GET /v1/admin/ads/invalid-clicks", () => {
  it("lists only reviewable invalid clicks, keyset paged, without session data", async () => {
    const p1 = await get("/v1/admin/ads/invalid-clicks?limit=1", TOKENS.admin);
    expect(p1.status).toBe(200);
    expect(p1.body.items.map((i: { id: string }) => i.id)).toEqual([U(901)]);
    expect(JSON.stringify(p1.body)).not.toMatch(/session|jti/);
    const p2 = await get(`/v1/admin/ads/invalid-clicks?limit=1&cursor=${p1.body.next_cursor as string}`, TOKENS.admin);
    expect(p2.body.items.map((i: { id: string }) => i.id)).toEqual([U(902)]);
    expect(p2.body.next_cursor).toBeNull();
  });
  it("400 on a bad cursor, 401 wrong audience or none, 403 non-ads admin", async () => {
    expect((await get("/v1/admin/ads/invalid-clicks?cursor=%%%", TOKENS.admin)).status).toBe(400);
    expect((await get("/v1/admin/ads/invalid-clicks?cursor=AAAAAAAAAA", TOKENS.admin)).status).toBe(400);
    expect((await get("/v1/admin/ads/invalid-clicks", null)).status).toBe(401);
    expect((await get("/v1/admin/ads/invalid-clicks", TOKENS.ownerA)).status).toBe(401);
    expect((await get("/v1/admin/ads/invalid-clicks", TOKENS.adminSupport)).status).toBe(403);
  });
});

describe("POST /v1/admin/ads/invalid-clicks/{id}/decision", () => {
  const path = (id: string) => `/v1/admin/ads/invalid-clicks/${id}/decision`;
  const body = { decision: "confirm_invalid", reason_code: "bot_pattern" };
  it("decides once, replays idempotently, conflicts on a different decision, and removes it from the queue", async () => {
    const key = idem();
    const a = await post(path(U(901)), TOKENS.admin, body, key);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ click_id: U(901), decision: "confirm_invalid", replayed: false });
    const b = await post(path(U(901)), TOKENS.admin, body, key);
    expect(b.body.click_id).toBe(U(901));
    expect((await post(path(U(901)), TOKENS.admin, { ...body, decision: "flag_store" })).status).toBe(409);
    const q = await get("/v1/admin/ads/invalid-clicks", TOKENS.admin);
    expect(q.body.items.map((i: { id: string }) => i.id)).toEqual([U(902)]);
  });
  it("404 unknown click, 409 not reviewable, 400 bad body, no money moves", async () => {
    expect((await post(path(U(999)), TOKENS.admin, body)).status).toBe(404);
    expect((await post(path(U(903)), TOKENS.admin, body)).status).toBe(409);
    expect((await post(path(U(902)), TOKENS.admin, { decision: "refund", reason_code: "x" })).status).toBe(400);
    expect((await post(path(U(902)), TOKENS.admin, body, {})).status).toBe(400);
    expect(await h.rt.store.getBalance(STORE_A)).toBe(0n);
  });
  it("401 wrong audience or none, 403 non-ads admin", async () => {
    expect((await post(path(U(902)), null, body)).status).toBe(401);
    expect((await post(path(U(902)), TOKENS.ownerA, body)).status).toBe(401);
    expect((await post(path(U(902)), TOKENS.adminSupport, body)).status).toBe(403);
  });
});
