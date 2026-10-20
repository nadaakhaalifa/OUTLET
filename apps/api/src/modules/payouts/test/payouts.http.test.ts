import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPayoutsHarness, adminActor, sellerActor, shopperActor, type PayoutsHarness } from "./harness";
import { CUTOFF, DAY, FINANCE_1, FINANCE_2, OLD, STORE_A, STORE_B, U, addOrder, seedStore } from "./fixtures";

const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
const MISSING = U(0xdead);

const T = {
  ownerA: "token-owner-store-a-0001",
  financeA: "token-finance-store-a-0001",
  managerA: "token-manager-store-a-0001",
  supportA: "token-support-store-a-0001",
  warehouseA: "token-warehouse-store-a-01",
  noScopeA: "token-owner-a-no-scope-001",
  suspendedA: "token-suspended-store-a-01",
  ownerB: "token-owner-store-b-0001",
  shopperOnSeller: "token-shopper-seller-aud-1",
  buyerAudOwnerA: "token-buyer-aud-owner-a-1",
  finance: "token-admin-finance-00001",
  finance2: "token-admin-finance-00002",
  ops: "token-admin-ops-0000000001",
  support: "token-admin-support-000001",
  financeNoPasskey: "token-admin-finance-nopass",
  financeNoScope: "token-admin-finance-noscope",
  sellerOnAdmin: "token-seller-on-admin-aud-1",
  adminOnSeller: "token-admin-on-seller-aud-1",
};

let h: PayoutsHarness;
let key = 5000;
const next = (): string => IDEM(key++);
let payoutId = "";
let payoutB = "";

beforeEach(async () => {
  if (h !== undefined) await h.close();
  h = await createPayoutsHarness();
  const t = h.tokens;
  t.add(T.ownerA, { actor: sellerActor(U(21), STORE_A, "owner"), aud: "seller_api" });
  t.add(T.financeA, { actor: sellerActor(U(24), STORE_A, "finance"), aud: "seller_api" });
  t.add(T.managerA, { actor: sellerActor(U(22), STORE_A, "manager"), aud: "seller_api" });
  t.add(T.supportA, { actor: sellerActor(U(23), STORE_A, "support"), aud: "seller_api" });
  t.add(T.warehouseA, { actor: sellerActor(U(25), STORE_A, "warehouse"), aud: "seller_api" });
  t.add(T.noScopeA, { actor: sellerActor(U(26), STORE_A, "owner", { tokenScopes: [] }), aud: "seller_api" });
  t.add(T.suspendedA, { actor: sellerActor(U(27), STORE_A, "owner", { status: "suspended" }), aud: "seller_api" });
  t.add(T.ownerB, { actor: sellerActor(U(28), STORE_B, "owner"), aud: "seller_api" });
  t.add(T.shopperOnSeller, { actor: shopperActor(U(29)), aud: "seller_api" });
  t.add(T.buyerAudOwnerA, { actor: sellerActor(U(21), STORE_A, "owner"), aud: "buyer_api" });
  t.add(T.finance, { actor: adminActor(FINANCE_1, "finance"), aud: "admin_api" });
  t.add(T.finance2, { actor: adminActor(FINANCE_2, "finance"), aud: "admin_api" });
  t.add(T.ops, { actor: adminActor(U(41), "ops"), aud: "admin_api" });
  t.add(T.support, { actor: adminActor(U(42), "support"), aud: "admin_api" });
  t.add(T.financeNoPasskey, { actor: adminActor(U(43), "finance", { assurance: "basic" }), aud: "admin_api" });
  t.add(T.financeNoScope, { actor: adminActor(U(44), "finance", { tokenScopes: [] }), aud: "admin_api" });
  t.add(T.sellerOnAdmin, { actor: sellerActor(U(21), STORE_A, "owner"), aud: "admin_api" });
  t.add(T.adminOnSeller, { actor: adminActor(FINANCE_1, "finance"), aud: "seller_api" });

  const k = h.kit;
  seedStore(k, STORE_A);
  seedStore(k, STORE_B, { legalName: "Delta Wear", holder: "Delta Wear" });
  addOrder(k, 1, 80_000n);
  addOrder(k, 2, 70_000n, { storeId: STORE_B });
  await k.commands.schedule();
  const all = await h.store.list({ scope: { kind: "system" }, after: null, limit: 10 });
  payoutId = all.items.find((p) => p.storeId === STORE_A)?.id ?? "";
  payoutB = all.items.find((p) => p.storeId === STORE_B)?.id ?? "";
});
afterAll(async () => {
  if (h !== undefined) await h.close();
});

const get = (path: string, token: string | null) => {
  let r = h.http().get(path);
  if (token !== null) r = r.set(bearer(token));
  return r;
};
const post = (path: string, token: string | null, k: string | null, body?: object) => {
  let r = h.http().post(path);
  if (token !== null) r = r.set(bearer(token));
  if (k !== null) r = r.set("Idempotency-Key", k);
  return r.send(body ?? {});
};

describe("GET /v1/seller/payouts", () => {
  it("lists only the caller's store and hides staff-only fields", async () => {
    const r = await get("/v1/seller/payouts", T.ownerA);
    expect(r.status).toBe(200);
    expect(r.body.items.map((p: { id: string }) => p.id)).toEqual([payoutId]);
    const p = r.body.items[0];
    expect(p).toMatchObject({ status: "SCHEDULED", amount: { amount: "80000", currency: "EGP" }, iban_last4: "0002" });
    for (const hidden of ["hold_reason", "approved_by", "approval_id", "ledger_ref", "provider_ref", "lines", "account_token"]) {
      expect(p).not.toHaveProperty(hidden);
    }
    expect(JSON.stringify(p)).not.toMatch(/tok-/);
    const b = await get("/v1/seller/payouts", T.ownerB);
    expect(b.body.items.map((x: { id: string }) => x.id)).toEqual([payoutB]);
  });

  it("owner, manager and finance may read; support and warehouse may not", async () => {
    for (const t of [T.ownerA, T.managerA, T.financeA]) expect((await get("/v1/seller/payouts", t)).status).toBe(200);
    for (const t of [T.supportA, T.warehouseA]) expect((await get("/v1/seller/payouts", t)).status).toBe(403);
  });

  it("negative authorization", async () => {
    expect((await get("/v1/seller/payouts", null)).status).toBe(401);
    expect((await get("/v1/seller/payouts", T.buyerAudOwnerA)).status).toBe(401);
    expect((await get("/v1/seller/payouts", T.adminOnSeller)).status).toBe(403);
    expect((await get("/v1/seller/payouts", T.shopperOnSeller)).status).toBe(403);
    expect((await get("/v1/seller/payouts", T.suspendedA)).status).toBe(403);
    expect((await get("/v1/seller/payouts", T.noScopeA)).status).toBe(403);
  });

  it("filters, validates query and refuses a foreign store filter as 404", async () => {
    expect((await get("/v1/seller/payouts?status=SETTLED", T.ownerA)).body.items).toEqual([]);
    expect((await get("/v1/seller/payouts?status=bogus", T.ownerA)).status).toBe(400);
    expect((await get("/v1/seller/payouts?cursor=%%%", T.ownerA)).status).toBe(400);
    expect((await get("/v1/seller/payouts?limit=0", T.ownerA)).status).toBe(400);
    expect((await get("/v1/seller/payouts?junk=1", T.ownerA)).status).toBe(400);
    expect((await get(`/v1/seller/payouts?store_id=${STORE_B}`, T.ownerA)).status).toBe(404);
    expect((await get(`/v1/seller/payouts?store_id=${STORE_A}`, T.ownerA)).status).toBe(200);
  });
});

describe("GET /v1/seller/payouts/{id}", () => {
  it("returns the payout with an ETag and supports If-None-Match", async () => {
    const r = await get(`/v1/seller/payouts/${payoutId}`, T.ownerA);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(payoutId);
    const etag = r.headers["etag"] as string;
    expect(etag).toBeTruthy();
    const again = await h.http().get(`/v1/seller/payouts/${payoutId}`).set(bearer(T.ownerA)).set("If-None-Match", etag);
    expect(again.status).toBe(304);
  });

  it("another store's payout is 404 and byte-identical to a missing one", async () => {
    const foreign = await get(`/v1/seller/payouts/${payoutB}`, T.ownerA);
    const missing = await get(`/v1/seller/payouts/${MISSING}`, T.ownerA);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    const strip = (b: Record<string, unknown>) => ({ ...b, request_id: undefined });
    expect(strip(foreign.body)).toEqual(strip(missing.body));
    expect((await get("/v1/seller/payouts/not-a-uuid", T.ownerA)).status).toBe(404);
  });

  it("wrong role, scope, audience and status are refused", async () => {
    expect((await get(`/v1/seller/payouts/${payoutId}`, T.supportA)).status).toBe(403);
    expect((await get(`/v1/seller/payouts/${payoutId}`, T.noScopeA)).status).toBe(403);
    expect((await get(`/v1/seller/payouts/${payoutId}`, T.suspendedA)).status).toBe(403);
    expect((await get(`/v1/seller/payouts/${payoutId}`, T.buyerAudOwnerA)).status).toBe(401);
    expect((await get(`/v1/seller/payouts/${payoutId}`, null)).status).toBe(401);
  });
});

describe("GET /v1/seller/stores/{id}/statements", () => {
  const period = `from=${encodeURIComponent(new Date(OLD - 10 * DAY).toISOString())}&to=${encodeURIComponent(new Date(CUTOFF + 10 * DAY).toISOString())}`;

  it("returns a statement with commission and VAT lines and the payout memo", async () => {
    h.kit.source.statementFacts.set(STORE_A, [
      { type: "order", id: "o-1", storeId: STORE_A, atMs: OLD - DAY, merchandise: 100_000n, commissionBps: 1_500n, vatBps: 1_400n },
      { type: "refund", id: "r-1", storeId: STORE_A, atMs: CUTOFF + DAY, goodsRefunded: 10_000n, goodsRefundedBefore: 0n, commissionBps: 1_500n, vatBps: 1_400n },
    ]);
    const r = await get(`/v1/seller/stores/${STORE_A}/statements?${period}`, T.financeA);
    expect(r.status).toBe(200);
    // 100,000 - 15% commission (15,000) - 14% VAT on commission (2,100) = 82,900
    expect(r.body.lines[0]).toMatchObject({
      type: "order",
      commission: { amount: "15000" },
      vat_on_commission: { amount: "2100" },
      net: { amount: "82900" },
    });
    expect(r.body.lines[1]).toMatchObject({ type: "refund", merchandise: { amount: "-10000" }, net: { amount: "-8290" } });
    expect(r.body.closing_balance.amount).toBe("74610");
    expect(r.body.payouts.map((p: { id: string }) => p.id)).toEqual([payoutId]);
  });

  it("foreign and missing stores are 404, roles and audience are enforced, bad periods are 400", async () => {
    const foreign = await get(`/v1/seller/stores/${STORE_B}/statements?${period}`, T.ownerA);
    const missing = await get(`/v1/seller/stores/${MISSING}/statements?${period}`, T.ownerA);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect((await get(`/v1/seller/stores/${STORE_A}/statements?${period}`, T.supportA)).status).toBe(403);
    expect((await get(`/v1/seller/stores/${STORE_A}/statements?${period}`, T.buyerAudOwnerA)).status).toBe(401);
    expect((await get(`/v1/seller/stores/${STORE_A}/statements?${period}`, null)).status).toBe(401);
    const back = `from=${encodeURIComponent(new Date(CUTOFF).toISOString())}&to=${encodeURIComponent(new Date(OLD).toISOString())}`;
    expect((await get(`/v1/seller/stores/${STORE_A}/statements?${back}`, T.ownerA)).status).toBe(400);
    expect((await get(`/v1/seller/stores/${STORE_A}/statements`, T.ownerA)).status).toBe(400);
    const huge = `from=${encodeURIComponent(new Date(0).toISOString())}&to=${encodeURIComponent(new Date(CUTOFF).toISOString())}`;
    expect((await get(`/v1/seller/stores/${STORE_A}/statements?${huge}`, T.ownerA)).status).toBe(400);
  });
});

describe("admin finance payouts", () => {
  it("finance and ops read everything with staff fields; others are refused", async () => {
    const r = await get("/v1/admin/finance/payouts", T.finance);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items[0]).toHaveProperty("hold_reason");
    expect((await get("/v1/admin/finance/payouts", T.ops)).status).toBe(200);
    expect((await get(`/v1/admin/finance/payouts/${payoutId}`, T.ops)).status).toBe(200);
    for (const t of [T.support, T.financeNoPasskey, T.financeNoScope]) {
      expect((await get("/v1/admin/finance/payouts", t)).status).toBe(403);
      expect((await get(`/v1/admin/finance/payouts/${payoutId}`, t)).status).toBe(403);
    }
    expect((await get("/v1/admin/finance/payouts", T.sellerOnAdmin)).status).toBe(403);
    expect((await get("/v1/admin/finance/payouts", T.ownerA)).status).toBe(401);
    expect((await get("/v1/admin/finance/payouts", null)).status).toBe(401);
    expect((await get(`/v1/admin/finance/payouts/${MISSING}`, T.finance)).status).toBe(404);
  });

  it("filters by store and status", async () => {
    const r = await get(`/v1/admin/finance/payouts?store_id=${STORE_B}&status=SCHEDULED`, T.finance);
    expect(r.body.items.map((p: { id: string }) => p.id)).toEqual([payoutB]);
  });

  it("approve needs the finance role and an idempotency key, and is idempotent", async () => {
    expect((await post(`/v1/admin/finance/payouts/${payoutId}/approve`, T.finance, null)).status).toBe(400);
    expect((await post(`/v1/admin/finance/payouts/${payoutId}/approve`, T.ops, next())).status).toBe(403);
    expect((await post(`/v1/admin/finance/payouts/${payoutId}/approve`, T.support, next())).status).toBe(403);
    expect((await post(`/v1/admin/finance/payouts/${payoutId}/approve`, null, next())).status).toBe(401);
    expect((await post(`/v1/admin/finance/payouts/${payoutId}/approve`, T.sellerOnAdmin, next())).status).toBe(403);
    expect((await post(`/v1/admin/finance/payouts/${MISSING}/approve`, T.finance, next())).status).toBe(404);

    const k = next();
    const ok = await post(`/v1/admin/finance/payouts/${payoutId}/approve`, T.finance, k);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "APPROVED", approved_by: FINANCE_1 });
    const replay = await post(`/v1/admin/finance/payouts/${payoutId}/approve`, T.finance, k);
    expect(replay.status).toBe(200);
    expect(h.store.outbox.filter((e) => e.type === "payout.approved")).toHaveLength(1);
    // a second approve with a new key on an APPROVED payout is a state conflict
    const again = await post(`/v1/admin/finance/payouts/${payoutId}/approve`, T.finance2, next());
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("invalid_transition");
  });

  it("an amount at the threshold needs a different approver's record", async () => {
    addOrder(h.kit, 50, 6_000_000n, { storeId: STORE_A });
    h.clock.advance(7 * DAY);
    h.kit.source.itemsByStore.get(STORE_A)?.forEach((i) => void i);
    await h.kit.commands.schedule();
    const page = await h.store.list({ scope: { kind: "system" }, storeId: STORE_A, status: "SCHEDULED", after: null, limit: 5 });
    const big = page.items.find((p) => p.amount >= 5_000_000n);
    expect(big).toBeDefined();
    const id = big?.id ?? "";
    const refused = await post(`/v1/admin/finance/payouts/${id}/approve`, T.finance, next());
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("dual_approval_required");
    h.kit.approvals.records.push({
      id: U(777),
      kind: "payout",
      subjectType: "payout",
      subjectId: id,
      amountMinor: big?.amount ?? 0n,
      reasonCode: "scheduled_payout",
      requesterId: FINANCE_1,
      state: "APPROVED",
      approverId: FINANCE_2,
      requestedAtMs: 0,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
      decidedAtMs: 1,
      decisionNote: null,
    });
    const ok = await post(`/v1/admin/finance/payouts/${id}/approve`, T.finance, next());
    expect(ok.status).toBe(200);
    expect(ok.body.approval_id).toBe(U(777));
  });

  it("hold and cancel", async () => {
    const held = await post(`/v1/admin/finance/payouts/${payoutId}/hold`, T.finance, next());
    expect(held.body).toMatchObject({ status: "ON_HOLD", hold_reason: "manual_hold" });
    const cancelled = await post(`/v1/admin/finance/payouts/${payoutId}/cancel`, T.finance, next());
    expect(cancelled.body.status).toBe("CANCELLED");
    expect((await post(`/v1/admin/finance/payouts/${payoutId}/cancel`, T.ops, next())).status).toBe(403);
    expect((await post(`/v1/admin/finance/payouts/${payoutId}/cancel`, T.finance, next(), { x: 1 })).status).toBe(400);
  });

  it("writes an audit record for allowed and denied decisions", async () => {
    await get("/v1/admin/finance/payouts", T.support);
    await get(`/v1/admin/finance/payouts/${payoutId}`, T.finance);
    const records = h.audit.entries;
    expect(records.some((r) => r.effect === "deny" && r.resourceType === "payout")).toBe(true);
    expect(records.some((r) => r.effect === "allow" && r.resourceType === "payout")).toBe(true);
  });
});
