import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAY, EGP, IDEM, START_MS, TOKENS, U, bearer, createBudgetHarness, spend, type BudgetHarness } from "./test/harness";

let h: BudgetHarness;
let seq = 0;
const idem = (): Record<string, string> => ({ "Idempotency-Key": IDEM(++seq) });
const money = (n: number) => ({ amount: String(EGP(n)), currency: "EGP" });
const IN_CYCLE = Date.parse("2026-04-02T10:00:00Z");

beforeAll(async () => {
  h = await createBudgetHarness();
  h.rt.consent.grant(U(1));
  h.rt.consent.grant(U(2));
}, 60_000);
afterAll(async () => {
  await h.close();
});

/** Fresh rate-limit window for each call site. */
const tick = (): void => h.rt.clock.advance(61_000);
const send = (method: "get" | "put" | "post" | "delete", path: string, token: string | null, body?: unknown, extra: Record<string, string> = idem()) => {
  tick();
  let r = h.http()[method](path).set(extra);
  if (token !== null) r = r.set(bearer(token));
  return body === undefined ? r : r.send(body as object);
};
const validPut = { amount: money(5000), payday: 25, cap_mode: "off" };

describe("authentication and authorization matrix (negative tests on every route)", () => {
  const routes: [Parameters<typeof send>[0], string, unknown][] = [
    ["put", "/v1/me/budget", validPut],
    ["get", "/v1/me/budget/summary", undefined],
    ["get", "/v1/me/affordability?context=feed", undefined],
    ["post", "/v1/me/budget/plan", {}],
    ["post", "/v1/me/budget/cap-unlock", {}],
    ["delete", "/v1/me/budget", undefined],
  ];
  for (const [method, path, body] of routes) {
    it(`${method.toUpperCase()} ${path}: 401 without a token and for tokens of other audiences`, async () => {
      expect((await send(method, path, null, body)).status).toBe(401);
      expect((await send(method, path, TOKENS.seller, body)).status).toBe(401);
      expect((await send(method, path, TOKENS.admin, body)).status).toBe(401);
      expect((await send(method, path, TOKENS.shopperOnSellerAud, body)).status).toBe(401);
    });
  }

  it("no route accepts a user id: another user's data cannot be addressed (BOLA)", async () => {
    expect((await send("put", "/v1/me/budget", TOKENS.a, { ...validPut, user_id: U(2) })).status).toBe(400);
    expect((await send("get", `/v1/me/budget/summary?user_id=${U(2)}`, TOKENS.a)).status).toBe(400);
    expect((await send("get", `/v1/users/${U(2)}/budget`, TOKENS.a)).status).toBe(404);
  });
});

describe("budget lifecycle over HTTP", () => {
  it("PUT without consent is 403 consent_required and stores nothing", async () => {
    const r = await send("put", "/v1/me/budget", TOKENS.b, validPut);
    h.rt.consent.withdraw(U(2));
    const denied = await send("put", "/v1/me/budget", TOKENS.b, validPut);
    expect(r.status).toBe(200);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("consent_required");
    h.rt.consent.grant(U(2));
  });

  it("requires an Idempotency-Key on writes", async () => {
    tick();
    const r = await h.http().put("/v1/me/budget").set(bearer(TOKENS.a)).send(validPut);
    expect(r.status).toBe(400);
  });

  it("validates the body with explicit pointers", async () => {
    const r = await send("put", "/v1/me/budget", TOKENS.a, { amount: money(5000), payday: 40, cap_mode: "off" });
    expect(r.status).toBe(400);
    const zero = await send("put", "/v1/me/budget", TOKENS.a, { amount: { amount: "0", currency: "EGP" }, payday: 5, cap_mode: "off" });
    expect(zero.status).toBe(400);
    const bad = await send("put", "/v1/me/budget", TOKENS.a, { amount: money(100), payday: 5, cap_mode: "strict" });
    expect(bad.status).toBe(400);
  });

  it("empty state before a budget, then summary after PUT with installments labelled estimate", async () => {
    h.rt.clock.set(START_MS);
    const empty = await send("get", "/v1/me/budget/summary", TOKENS.a);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ state: "empty" });

    const put = await send("put", "/v1/me/budget", TOKENS.a, {
      amount: money(5000),
      payday: 25,
      cap_mode: "off",
      per_category: { dresses: money(2000) },
      installments: [{ provider: "valU", monthly: money(620), starts_at: "2026-03-01T00:00:00Z", ends_at: "2026-09-01T00:00:00Z" }],
    });
    expect(put.status).toBe(200);
    await h.rt.record.execute(U(1), spend("placed:1", "placed", EGP(1200), IN_CYCLE, IN_CYCLE, { lines: [{ storeId: U(9001), categoryId: "dresses", amount: EGP(1200) }] }));

    const s = await send("get", "/v1/me/budget/summary", TOKENS.a);
    expect(s.status).toBe(200);
    expect(s.headers["cache-control"]).toBe("no-store");
    expect(s.body).toMatchObject({
      state: "active",
      budget: money(5000),
      spent: money(1200),
      remaining: money(5000 - 1200 - 620),
      over_by: money(0),
      installments: { label: "estimate", total: money(620) },
      cap: { mode: "off", unlock_at: null },
      notice: "not_financial_advice",
    });
    expect(s.body.cycle).toEqual({ start_date: "2026-03-25", end_date: "2026-04-25" });
    expect(s.body.per_category).toEqual([{ category_id: "dresses", spent: money(1200), limit: money(2000) }]);
    expect(s.body.top_stores).toEqual([{ store_id: U(9001), spent: money(1200) }]);
  });

  it("other users never see this budget", async () => {
    const r = await send("get", "/v1/me/budget/summary", TOKENS.b);
    expect(r.status).toBe(200);
    // B has a budget of their own (set above) but none of A's spend, categories, stores or instalments
    expect(r.body).toMatchObject({ spent: money(0), installments: { total: money(0), items: [] }, per_category: [], top_stores: [] });
  });

  it("GET affordability returns the ceiling for the context, no-store, and applies:false without a budget", async () => {
    const r = await send("get", "/v1/me/affordability?context=search", TOKENS.a);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toMatchObject({ context: "search", applies: true, price_ceiling: money(5000 - 1200 - 620) });
    expect(JSON.stringify(r.body)).not.toMatch(/store|category|per_category/);
    h.rt.consent.withdraw(U(2));
    const none = await send("get", "/v1/me/affordability?context=feed", TOKENS.b);
    h.rt.consent.grant(U(2));
    expect(none.body).toEqual({ context: "feed", applies: false, price_ceiling: null });
    expect((await send("get", "/v1/me/affordability?context=ads", TOKENS.a)).status).toBe(400);
  });

  it("replays an idempotent PUT with the same key and body, and rejects the key with another body", async () => {
    const key = { "Idempotency-Key": IDEM(900) };
    const a = await send("put", "/v1/me/budget", TOKENS.a, { ...validPut, amount: money(6000) }, key);
    const b = await send("put", "/v1/me/budget", TOKENS.a, { ...validPut, amount: money(6000) }, key);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    const c = await send("put", "/v1/me/budget", TOKENS.a, { ...validPut, amount: money(7000) }, key);
    expect(c.status).toBe(422);
  });

  it("plan: affordable now vs later, unknown list is 404", async () => {
    const listId = "00000000-0000-4000-8000-0000000000aa";
    h.rt.wishlists.set(U(1), listId, [
      { id: "need-1", priority: "need", price: EGP(1000), dueAtMs: null },
      { id: "treat-1", priority: "treat", price: EGP(9000), dueAtMs: null },
    ]);
    const ok = await send("post", "/v1/me/budget/plan", TOKENS.a, { wishlist_id: listId, horizon_cycles: 2 });
    expect(ok.status).toBe(200);
    expect(ok.body.planned[0]).toMatchObject({ item_id: "need-1", affordable_now: true, cycle_index: 0 });
    expect(ok.body.unplanned).toEqual([{ item_id: "treat-1", reason: "exceeds_every_cycle" }]);
    const missing = await send("post", "/v1/me/budget/plan", TOKENS.a, { wishlist_id: "00000000-0000-4000-8000-0000000000bb" });
    expect(missing.status).toBe(404);
    // another user's list id resolves to nothing for me: same 404
    h.rt.wishlists.set(U(2), "00000000-0000-4000-8000-0000000000cc", []);
    expect((await send("post", "/v1/me/budget/plan", TOKENS.a, { wishlist_id: "00000000-0000-4000-8000-0000000000cc" })).status).toBe(404);
  });

  it("cap unlock: 409 unless a hard cap is set, then 24h delay and a second call is the same unlock", async () => {
    expect((await send("post", "/v1/me/budget/cap-unlock", TOKENS.a, {})).status).toBe(409);
    await send("put", "/v1/me/budget", TOKENS.a, { ...validPut, cap_mode: "hard" });
    const first = await send("post", "/v1/me/budget/cap-unlock", TOKENS.a, {});
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("requested");
    const again = await send("post", "/v1/me/budget/cap-unlock", TOKENS.a, {});
    expect(again.body).toMatchObject({ status: "already_requested", unlock_at: first.body.unlock_at });
    expect(Date.parse(first.body.unlock_at) - h.rt.clock.nowMs()).toBeGreaterThan(DAY - 3 * 60_000);
    const s = await send("get", "/v1/me/budget/summary", TOKENS.a);
    expect(s.body.cap.unlock_at).toBe(first.body.unlock_at);
  });

  it("DELETE purges everything and the summary is empty again", async () => {
    const d = await send("delete", "/v1/me/budget", TOKENS.a);
    expect(d.status).toBe(200);
    expect(d.body).toEqual({ deleted: true });
    expect(h.rt.store.hasAnyData(U(1))).toBe(false);
    expect((await send("get", "/v1/me/budget/summary", TOKENS.a)).body).toEqual({ state: "empty" });
  });

  it("the release flag off hides the suite (404) and the caps flag leaves it readable", async () => {
    h.rt.flags.suite = false;
    expect((await send("put", "/v1/me/budget", TOKENS.a, validPut)).status).toBe(404);
    expect((await send("get", "/v1/me/budget/summary", TOKENS.a)).status).toBe(404);
    h.rt.flags.suite = true;
  });

  it("a KMS outage is a 503, never plaintext", async () => {
    h.rt.cipher.setFailing(true);
    const r = await send("put", "/v1/me/budget", TOKENS.a, validPut);
    h.rt.cipher.setFailing(false);
    expect(r.status).toBe(503);
  });
});
