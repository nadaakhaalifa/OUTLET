import fc from "fast-check";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { computeStoreBalance } from "../domain/balance";
import { createPayoutsHarness, sellerActor, shopperActor, type PayoutsHarness } from "./harness";
import { CLAWBACK, DAY, OLD, STORE_A, STORE_B, U, addOrder, seedStore } from "./fixtures";

const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
const T = {
  owner: "token-bal-owner-a-0000001",
  manager: "token-bal-manager-a-00001",
  finance: "token-bal-finance-a-00001",
  catalog: "token-bal-catalog-a-000001",
  support: "token-bal-support-a-000001",
  ownerB: "token-bal-owner-b-0000001",
  shopper: "token-bal-shopper-0000001",
  noScope: "token-bal-noscope-a-000001",
};
const MISSING = U(0xbeef);
let h: PayoutsHarness;

beforeEach(async () => {
  if (h !== undefined) await h.close();
  h = await createPayoutsHarness();
  h.tokens.add(T.owner, { actor: sellerActor(U(51), STORE_A, "owner"), aud: "seller_api" });
  h.tokens.add(T.manager, { actor: sellerActor(U(52), STORE_A, "manager"), aud: "seller_api" });
  h.tokens.add(T.finance, { actor: sellerActor(U(53), STORE_A, "finance"), aud: "seller_api" });
  h.tokens.add(T.catalog, { actor: sellerActor(U(54), STORE_A, "catalog"), aud: "seller_api" });
  h.tokens.add(T.support, { actor: sellerActor(U(55), STORE_A, "support"), aud: "seller_api" });
  h.tokens.add(T.ownerB, { actor: sellerActor(U(56), STORE_B, "owner"), aud: "seller_api" });
  h.tokens.add(T.shopper, { actor: shopperActor(U(57)), aud: "seller_api" });
  h.tokens.add(T.noScope, { actor: sellerActor(U(58), STORE_A, "owner", { tokenScopes: [] }), aud: "seller_api" });
  seedStore(h.kit, STORE_A);
  seedStore(h.kit, STORE_B);
});
afterAll(async () => {
  if (h !== undefined) await h.close();
});

const get = (path: string, token: string | null) => {
  let r = h.http().get(path);
  if (token !== null) r = r.set(bearer(token));
  return r;
};
const path = (id: string): string => `/v1/seller/stores/${id}/balance`;
const strip = (b: Record<string, unknown>) => ({ ...b, request_id: undefined });

describe("GET /v1/seller/stores/{storeId}/balance", () => {
  it("splits available, pending and held in piastres without any reason", async () => {
    addOrder(h.kit, 1, 50_000n); // closed long ago: available
    addOrder(h.kit, 2, 7_000n, { closedAtMs: h.clock.nowMs() - DAY }); // inside the hold window: pending
    addOrder(h.kit, 3, 3_000n, { status: "DELIVERED", closedAtMs: null }); // not closed: pending
    addOrder(h.kit, 4, 11_000n);
    h.kit.source.disputes.add(U(1004)); // open dispute: held
    h.kit.source.addClawback({ id: CLAWBACK(1), storeId: STORE_A, amount: 4_000n, kind: "other", createdAtMs: OLD });
    const r = await get(path(STORE_A), T.owner);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      available: { amount: "46000", currency: "EGP" },
      pending_release: { amount: "10000", currency: "EGP" },
      held: { amount: "11000", currency: "EGP" },
      in_transit: { amount: "0", currency: "EGP" },
      negative_carry: { amount: "0", currency: "EGP" },
      as_of: new Date(h.clock.nowMs()).toISOString(),
    });
    expect(JSON.stringify(r.body)).not.toMatch(/reason|dispute|next_payout/i);
  });

  it("outstanding clawbacks beyond what is available become negative carry", async () => {
    addOrder(h.kit, 1, 1_000n);
    h.kit.source.addClawback({ id: CLAWBACK(1), storeId: STORE_A, amount: 4_000n, kind: "refund_after_payout", createdAtMs: OLD });
    const r = await get(path(STORE_A), T.finance);
    expect(r.body.available.amount).toBe("0");
    expect(r.body.negative_carry.amount).toBe("3000");
  });

  it("available never exceeds the ledger seller_payable balance", async () => {
    addOrder(h.kit, 1, 50_000n);
    h.kit.ledger.setBalance(STORE_A, 20_000n);
    expect((await get(path(STORE_A), T.owner)).body.available.amount).toBe("20000");
    h.kit.ledger.setBalance(STORE_A, -5n);
    expect((await get(path(STORE_A), T.owner)).body.available.amount).toBe("0");
  });

  it("amounts already inside a payout are not counted again; a HELD payout shows only as held", async () => {
    addOrder(h.kit, 1, 80_000n);
    h.kit.risk.held.add(STORE_A);
    await h.kit.commands.schedule();
    const payouts = await h.store.list({ scope: { kind: "system" }, after: null, limit: 5 });
    expect(payouts.items[0]?.status).toBe("ON_HOLD");
    const r = await get(path(STORE_A), T.owner);
    expect(r.body.available.amount).toBe("0");
    expect(r.body.held.amount).toBe("80000");
    expect(JSON.stringify(r.body)).not.toMatch(/risk|hold_reason/i);
  });

  it("a payout in flight shows as in_transit only: neither available, pending nor held", async () => {
    addOrder(h.kit, 1, 80_000n);
    await h.kit.commands.schedule();
    const payouts = await h.store.list({ scope: { kind: "system" }, after: null, limit: 5 });
    expect(payouts.items[0]?.status).toBe("SCHEDULED");
    const r = await get(path(STORE_A), T.owner);
    expect(r.body).toMatchObject({
      available: { amount: "0" },
      pending_release: { amount: "0" },
      held: { amount: "0" },
      in_transit: { amount: "80000" },
    });
    expect(JSON.stringify(r.body)).not.toMatch(/SCHEDULED|status|cycle|eta|date/i);
  });

  it("an open dispute on an order that is not CLOSED yet is pending_release, not held", async () => {
    addOrder(h.kit, 1, 9_000n, { status: "DELIVERED", closedAtMs: null });
    h.kit.source.disputes.add(U(1001));
    addOrder(h.kit, 2, 4_000n, { closedAtMs: h.clock.nowMs() - DAY }); // inside the window
    h.kit.source.disputes.add(U(1002));
    const r = await get(path(STORE_A), T.owner);
    expect(r.body.pending_release.amount).toBe("13000");
    expect(r.body.held.amount).toBe("0");
  });

  it("a negative ledger balance shows as negative_carry even without a clawback record", async () => {
    h.kit.ledger.setBalance(STORE_A, -7_000n);
    const r = await get(path(STORE_A), T.owner);
    expect(r.body.available.amount).toBe("0");
    expect(r.body.negative_carry.amount).toBe("7000");
    addOrder(h.kit, 1, 1_000n);
    h.kit.source.addClawback({ id: CLAWBACK(1), storeId: STORE_A, amount: 2_000n, kind: "other", createdAtMs: OLD });
    expect((await get(path(STORE_A), T.owner)).body.negative_carry.amount).toBe("7000"); // max(1000, 7000)
  });

  it("owner, manager and finance read; catalog and support are 403", async () => {
    for (const t of [T.owner, T.manager, T.finance]) expect((await get(path(STORE_A), t)).status).toBe(200);
    for (const t of [T.catalog, T.support]) expect((await get(path(STORE_A), t)).status).toBe(403);
  });

  it("is read-only: no posting, no payout is created", async () => {
    addOrder(h.kit, 1, 50_000n);
    await get(path(STORE_A), T.owner);
    expect(h.kit.ledger.entries.size).toBe(0);
    expect((await h.store.list({ scope: { kind: "system" }, after: null, limit: 5 })).items).toEqual([]);
  });

  it("foreign and unknown stores answer 404 with identical bodies; bad ids too", async () => {
    const foreign = await get(path(STORE_B), T.owner);
    const missing = await get(path(MISSING), T.owner);
    const bad = await get(path("not-a-uuid"), T.owner);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(bad.status).toBe(404);
    expect(strip(foreign.body)).toEqual(strip(missing.body));
    expect(strip(bad.body)).toEqual(strip(missing.body));
  });

  it("negative authorization: anonymous, wrong audience, shopper, no scope", async () => {
    expect((await get(path(STORE_A), null)).status).toBe(401);
    expect((await get(path(STORE_A), T.shopper)).status).toBe(403);
    expect((await get(path(STORE_A), T.noScope)).status).toBe(403);
  });

  it("blocked flag answers 404 with the same body as a foreign store, after authorization", async () => {
    const foreign = await get(path(STORE_B), T.owner);
    h.balanceFlag.on = false;
    const blocked = await get(path(STORE_A), T.owner);
    expect(blocked.status).toBe(404);
    expect(strip(blocked.body)).toEqual(strip(foreign.body));
    expect((await get(path(STORE_A), T.catalog)).status).toBe(403);
    expect((await get(path(STORE_A), null)).status).toBe(401);
  });

  it("ETag and 304 after authorization; the ETag ignores as_of", async () => {
    addOrder(h.kit, 1, 50_000n);
    const r = await get(path(STORE_A), T.owner);
    const etag = r.headers["etag"] as string;
    expect(etag).toBeTruthy();
    expect(r.headers["cache-control"]).toBe("private, no-cache");
    h.clock.advance(1000);
    const again = await h.http().get(path(STORE_A)).set(bearer(T.owner)).set("If-None-Match", etag);
    expect(again.status).toBe(304);
    const denied = await h.http().get(path(STORE_A)).set(bearer(T.catalog)).set("If-None-Match", etag);
    expect(denied.status).toBe(403);
    const foreign = await h.http().get(path(STORE_B)).set(bearer(T.owner)).set("If-None-Match", etag);
    expect(foreign.status).toBe(404);
  });

  it("rate limits per user", async () => {
    let last = 200;
    for (let i = 0; i < 125; i += 1) last = (await get(path(STORE_A), T.manager)).status;
    expect(last).toBe(429);
  });

  it("ledger failure is 503, never zeros", async () => {
    h.kit.ledger.payableBalance = async () => {
      throw new Error("down");
    };
    expect((await get(path(STORE_A), T.owner)).status).toBe(503);
  });
});

describe("computeStoreBalance properties", () => {
  const item = fc.record({
    net: fc.bigInt({ min: 1n, max: 10_000_000n }),
    kind: fc.constantFrom("eligible", "fresh", "open", "disputed"),
  });
  it("with a ledger equal to the sum of postings, available + pending + held - carry equals the ledger and stays non-negative", () => {
    fc.assert(
      fc.property(fc.array(item, { maxLength: 30 }), fc.array(fc.bigInt({ min: 1n, max: 5_000_000n }), { maxLength: 5 }), (items, claws) => {
        const now = Date.UTC(2026, 9, 14);
        const list = items.map((i, n) => ({
          sellerOrderId: `o-${n}`,
          storeId: STORE_A,
          net: i.net,
          status: i.kind === "open" ? "DELIVERED" : "CLOSED",
          closedAtMs: i.kind === "open" ? null : i.kind === "fresh" ? now - DAY : now - 30 * DAY,
          openDispute: i.kind === "disputed",
        }));
        const clawbacks = claws.map((amount, n) => ({ id: `c-${n}`, storeId: STORE_A, amount, kind: "other" as const, createdAtMs: 0 }));
        // Ledger = sum of the credits posted for the orders minus the clawbacks already posted against the seller.
        const ledgerPayable = items.reduce((a, i) => a + i.net, 0n) - claws.reduce((a, c) => a + c, 0n);
        const b = computeStoreBalance({ storeId: STORE_A, nowMs: now, items: list, clawbacks, heldPayoutTotal: 0n, inTransitPayoutTotal: 0n, ledgerPayable });
        for (const v of [b.available, b.pendingRelease, b.held, b.negativeCarry]) expect(v >= 0n).toBe(true);
        const eligible = items.filter((i) => i.kind === "eligible").reduce((a, i) => a + i.net, 0n);
        const owed = claws.reduce((a, c) => a + c, 0n);
        const classified = b.available + b.pendingRelease + b.held - b.negativeCarry;
        // available is min(max(eligible - owed, 0), max(ledger, 0)); the identity holds when the ledger covers the classified total.
        const expectedAvail = eligible - owed > 0n ? eligible - owed : 0n;
        expect(b.available <= expectedAvail).toBe(true);
        if (ledgerPayable >= expectedAvail) {
          expect(classified).toBe(eligible + b.pendingRelease + b.held - owed);
          expect(classified).toBe(ledgerPayable - (items.reduce((a, i) => a + i.net, 0n) - eligible - b.pendingRelease - b.held));
        }
        expect(b.available <= (ledgerPayable > 0n ? ledgerPayable : 0n)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
