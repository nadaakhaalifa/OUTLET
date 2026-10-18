import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PAYOUT_STATES } from "../domain/bridge";
import { createPayoutsHarness, adminActor, sellerActor, shopperActor, type PayoutsHarness } from "./harness";
import { FINANCE_1, STORE_A, STORE_B, U, addOrder, seedStore } from "./fixtures";

const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
const PATH = "/v1/admin/finance/payouts/summary";

const T = {
  finance: "token-admin-finance-00001",
  ops: "token-admin-ops-0000000001",
  support: "token-admin-support-000001",
  marketing: "token-admin-marketing-0001",
  noPasskey: "token-admin-finance-nopass",
  noScope: "token-admin-finance-noscope",
  seller: "token-seller-on-admin-aud-1",
  sellerAud: "token-owner-store-a-0001",
  shopper: "token-shopper-on-admin-aud-1",
  adminOnSeller: "token-admin-on-seller-aud-1",
};

let h: PayoutsHarness;

beforeEach(async () => {
  if (h !== undefined) await h.close();
  h = await createPayoutsHarness();
  h.financeViewsFlag.on = true;
  const t = h.tokens;
  t.add(T.finance, { actor: adminActor(FINANCE_1, "finance"), aud: "admin_api" });
  t.add(T.ops, { actor: adminActor(U(41), "ops"), aud: "admin_api" });
  t.add(T.support, { actor: adminActor(U(42), "support"), aud: "admin_api" });
  t.add(T.marketing, { actor: adminActor(U(45), "marketing"), aud: "admin_api" });
  t.add(T.noPasskey, { actor: adminActor(U(43), "finance", { assurance: "basic" }), aud: "admin_api" });
  t.add(T.noScope, { actor: adminActor(U(44), "finance", { tokenScopes: [] }), aud: "admin_api" });
  t.add(T.seller, { actor: sellerActor(U(21), STORE_A, "owner"), aud: "admin_api" });
  t.add(T.sellerAud, { actor: sellerActor(U(21), STORE_A, "owner"), aud: "seller_api" });
  t.add(T.shopper, { actor: shopperActor(U(29)), aud: "admin_api" });
  t.add(T.adminOnSeller, { actor: adminActor(FINANCE_1, "finance"), aud: "seller_api" });

  const k = h.kit;
  seedStore(k, STORE_A);
  seedStore(k, STORE_B, { legalName: "Delta Wear", holder: "Delta Wear" });
  addOrder(k, 1, 80_000n);
  addOrder(k, 2, 70_000n, { storeId: STORE_B });
  await k.commands.schedule();
});
afterAll(async () => {
  if (h !== undefined) await h.close();
});

const get = (token: string | null, headers: Record<string, string> = {}) => {
  let r = h.http().get(PATH).set(headers);
  if (token !== null) r = r.set(bearer(token));
  return r;
};

async function walk() {
  const all = await h.store.list({ scope: { kind: "system" }, after: null, limit: 50 });
  return all.items;
}

describe("GET /v1/admin/finance/payouts/summary (B-1)", () => {
  it("answers 404 while release.admin.finance_views is blocked, even for finance", async () => {
    h.financeViewsFlag.on = false;
    expect((await get(T.finance)).status).toBe(404);
    // The audience guard runs first, so an anonymous caller learns nothing about the flag.
    expect((await get(null)).status).toBe(401);
    expect((await get(T.support)).status).toBe(403);
    expect((await get(T.ops)).status).toBe(404);
    // Blocked still audits the read.
    const n = h.audit.entries.length;
    await get(T.finance);
    expect(h.audit.entries.length).toBeGreaterThan(n);
  });

  it("has every state, integer-string amounts and totals equal to the rows", async () => {
    const r = await get(T.finance);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.by_state)).toEqual([...PAYOUT_STATES]);
    const rows = await walk();
    let count = 0;
    let amount = 0n;
    for (const st of PAYOUT_STATES) {
      const s = r.body.by_state[st];
      expect(s.amount.currency).toBe("EGP");
      expect(s.amount.amount).toMatch(/^-?\d+$/);
      const mine = rows.filter((p) => p.status === st);
      expect(s.count).toBe(mine.length);
      expect(BigInt(s.amount.amount)).toBe(mine.reduce((a, p) => a + p.amount, 0n));
      count += s.count;
      amount += BigInt(s.amount.amount);
    }
    expect(count).toBe(rows.length);
    expect(amount).toBe(rows.reduce((a, p) => a + p.amount, 0n));
    expect(r.body.by_state.SCHEDULED.count).toBe(2);
    expect(r.body.by_state.SETTLED.count).toBe(0);
    expect(r.body.by_state.SETTLED.oldest_updated_at).toBeNull();
    expect(r.body.settled_window_days).toBe(30);
    expect(new Date(r.body.next_cycle_at).getTime()).toBeGreaterThan(new Date(r.body.as_of).getTime());
  });

  it("buckets hold reasons so they sum to the ON_HOLD count", async () => {
    const id = (await walk())[0]?.id ?? "";
    const hold = await h.http().post(`/v1/admin/finance/payouts/${id}/hold`).set(bearer(T.finance)).set("Idempotency-Key", IDEM(9001)).send({});
    expect(hold.status).toBe(200);
    const r = await get(T.finance);
    const s = r.body.by_state.ON_HOLD;
    expect(s.count).toBe(1);
    expect(Object.values(s.by_hold_reason as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(s.count);
    expect(r.body.by_state.SCHEDULED.count).toBe(1);
    expect(r.body.by_state.SCHEDULED.by_hold_reason).toBeUndefined();
    expect(r.body.by_state.FAILED.by_failure_code).toEqual({});
  });

  it("counts SETTLED and CANCELLED only inside the 30 day window", async () => {
    const id = (await walk())[0]?.id ?? "";
    const c = await h.http().post(`/v1/admin/finance/payouts/${id}/cancel`).set(bearer(T.finance)).set("Idempotency-Key", IDEM(9002)).send({});
    expect(c.status).toBe(200);
    expect((await get(T.finance)).body.by_state.CANCELLED.count).toBe(1);
    h.clock.advance(31 * 86_400_000);
    expect((await get(T.finance)).body.by_state.CANCELLED.count).toBe(0);
  });

  it("allows finance and ops, refuses everyone else with identical 403/401 oracles", async () => {
    expect((await get(T.ops)).status).toBe(200);
    const denied = [T.support, T.marketing, T.noPasskey, T.noScope, T.seller, T.shopper];
    const bodies = [];
    for (const t of denied) {
      const r = await get(t);
      expect(r.status).toBe(403);
      bodies.push(r.body.code ?? r.body.type);
    }
    expect(new Set(bodies).size).toBeLessThanOrEqual(2);
    expect((await get(T.sellerAud)).status).toBe(401);
    expect((await get(T.adminOnSeller)).status).toBe(401);
    expect((await get(null)).status).toBe(401);
  });

  it("audits the read before answering and never leaks a 304 to an unauthorised caller", async () => {
    const before = h.audit.entries.length;
    const ok = await get(T.finance);
    expect(h.audit.entries.length).toBeGreaterThan(before);
    const etag = ok.headers["etag"] as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect((await get(T.finance, { "If-None-Match": etag })).status).toBe(304);
    // Same ETag, caller without the role or the session: authorization wins.
    expect((await get(T.support, { "If-None-Match": etag })).status).toBe(403);
    expect((await get(null, { "If-None-Match": etag })).status).toBe(401);
    // A state change invalidates the ETag.
    const id = (await walk())[0]?.id ?? "";
    await h.http().post(`/v1/admin/finance/payouts/${id}/hold`).set(bearer(T.finance)).set("Idempotency-Key", IDEM(9003)).send({});
    expect((await get(T.finance, { "If-None-Match": etag })).status).toBe(200);
  });

  it("is read only: POST is not routed", async () => {
    const r = await h.http().post(PATH).set(bearer(T.finance)).set("Idempotency-Key", IDEM(9004)).send({});
    expect([404, 405]).toContain(r.status);
  });
});
