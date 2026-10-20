import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTO_BUY_LIMITS } from "./domain/bridge";
import { IDEM, TOKENS, UU, bearer, createAutoBuyHarness, type AutoBuyHarness } from "./test/harness";
import { TOKEN, quote } from "./test/world";
import { SKU } from "./test/repository-contract";

let h: AutoBuyHarness;
let seq = 5000;
const idem = (): Record<string, string> => ({ "Idempotency-Key": IDEM(++seq) });
const ORDER = UU(777);
const WINDOW = AUTO_BUY_LIMITS.cancelWindowMs + 1_000;

beforeAll(async () => {
  h = await createAutoBuyHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

const tick = (): void => h.world.clock.advance(61_000);
const post = (path: string, token: string | null, payload: unknown = {}, extra: Record<string, string> = idem()) => {
  tick();
  let r = h.http().post(path).set(extra);
  if (token !== null) r = r.set(bearer(token));
  return r.send(payload as object);
};
const get = (path: string, token: string | null) => {
  tick();
  let r = h.http().get(path);
  if (token !== null) r = r.set(bearer(token));
  return r;
};

/** An unattended rule for shopper A whose charge went to the PSP and came back as `outcome`. */
async function parked(sku: number, outcome: { kind: "sca_required" } | { kind: "pending" }, user = 1): Promise<{ attemptId: string; key: string }> {
  const w = h.world;
  w.flags.charge = true;
  // One active rule per SKU and a per-user cap: free the user's earlier rules (open attempts keep their state).
  await w.cancelAll.execute(UU(user), "card_removed");
  w.catalog.skus.set(SKU(sku), quote());
  const r = await w.create.execute({
    userId: UU(user),
    skuId: SKU(sku),
    sizeLabel: "M",
    targetPrice: 64_900n,
    maxPrice: 70_000n,
    expiresAtMs: w.clock.nowMs() + 30 * 86_400_000,
    mode: "unattended",
    pspTokenRef: TOKEN,
    locale: "en",
    acceptedTermsVersion: 1,
    deviceId: "device-1",
  });
  if (r.kind !== "created") throw new Error(`arm failed: ${r.kind}`);
  // The price then drops to the target: the live recheck at charge time reads this quote.
  w.catalog.skus.set(SKU(sku), quote({ price: 64_000n }));
  await w.handle.execute({
    event_id: `pe-${sku}`,
    sku_id: SKU(sku),
    price: { amount: "64000", currency: "EGP" },
    verified: true,
    anomaly: false,
    occurred_at: new Date(w.clock.nowMs()).toISOString(),
  });
  w.mit.next = outcome;
  w.clock.advance(WINDOW);
  await w.sweep.execute();
  const a = w.store.attemptsAll.find((x) => x.mandateId === r.mandate.id);
  if (a === undefined) throw new Error("no attempt");
  return { attemptId: a.id, key: w.mit.placeCalls.at(-1)?.idempotencyKey ?? "" };
}

describe("POST /v1/me/auto-buy/attempts/:id/sca-complete", () => {
  it("is owner-only: 401 without a token and for other audiences, 404 for another shopper's attempt, 400 without an Idempotency-Key", async () => {
    const { attemptId } = await parked(1, { kind: "sca_required" });
    const path = `/v1/me/auto-buy/attempts/${attemptId}/sca-complete`;
    expect((await post(path, null)).status).toBe(401);
    expect((await post(path, TOKENS.seller)).status).toBe(401);
    expect((await post(path, TOKENS.shopperOnSellerAud)).status).toBe(401);
    expect((await post(path, TOKENS.adminOnBuyerAud)).status).toBe(404);
    const other = await post(path, TOKENS.b);
    expect(other.status).toBe(404);
    tick();
    expect((await h.http().post(path).set(bearer(TOKENS.a)).send({})).status).toBe(400);
    expect((await post(`/v1/me/auto-buy/attempts/${UU(999)}/sca-complete`, TOKENS.a)).status).toBe(404);
    expect((await post("/v1/me/auto-buy/attempts/not-a-uuid/sca-complete", TOKENS.a)).status).toBe(404);
    // Nothing moved for the stranger's attempt.
    expect(h.world.store.attemptsAll.find((a) => a.id === attemptId)?.state).toBe("REQUIRES_USER_ACTION");
  });

  it("does not trust the client: with no PSP record the answer is 409 sca_not_confirmed and the state is unchanged", async () => {
    const { attemptId } = await parked(2, { kind: "sca_required" });
    const r = await post(`/v1/me/auto-buy/attempts/${attemptId}/sca-complete`, TOKENS.a);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("sca_not_confirmed");
    expect(h.world.store.attemptsAll.find((a) => a.id === attemptId)?.state).toBe("REQUIRES_USER_ACTION");
  });

  it("an order the PSP shows as placed completes the purchase once; a replay and a second key both return the same order", async () => {
    const { attemptId, key } = await parked(3, { kind: "sca_required" });
    h.world.mit.placed.set(key, ORDER);
    const keyed = idem();
    const first = await post(`/v1/me/auto-buy/attempts/${attemptId}/sca-complete`, TOKENS.a, {}, keyed);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: "purchased", order_group_id: ORDER });
    expect(first.headers["cache-control"]).toBe("no-store");
    const attempt = h.world.store.attemptsAll.find((a) => a.id === attemptId);
    expect(attempt).toMatchObject({ state: "PURCHASED", orderGroupId: ORDER });
    expect(h.world.store.mandatesAll.find((m) => m.id === attempt?.mandateId)?.status).toBe("PURCHASED");
    const chargedEvents = h.world.store.events.filter((e) => e.type === "auto_buy.charged" && e.attemptId === attemptId);
    expect(chargedEvents).toHaveLength(1);

    const replay = await post(`/v1/me/auto-buy/attempts/${attemptId}/sca-complete`, TOKENS.a, {}, keyed);
    expect(replay.body).toEqual(first.body);
    const again = await post(`/v1/me/auto-buy/attempts/${attemptId}/sca-complete`, TOKENS.a);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ status: "purchased", order_group_id: ORDER });
    expect(h.world.store.events.filter((e) => e.type === "auto_buy.charged" && e.attemptId === attemptId)).toHaveLength(1);
    expect(h.world.mit.placeCalls.filter((c) => c.idempotencyKey === key)).toHaveLength(1);
  });

  it("a PSP-confirmed failure ends FAILED and releases the hold; an in-flight saga moves to CHARGING for the sweep", async () => {
    const failed = await parked(4, { kind: "sca_required" });
    h.world.mit.lookupAnswers.set(failed.key, { kind: "failed" });
    const f = await post(`/v1/me/auto-buy/attempts/${failed.attemptId}/sca-complete`, TOKENS.a);
    expect(f.body).toEqual({ status: "failed", order_group_id: null });
    expect(h.world.store.attemptsAll.find((a) => a.id === failed.attemptId)).toMatchObject({ state: "FAILED", failureReason: "psp_confirmed_not_charged" });
    expect(h.world.inventory.held.has(failed.attemptId)).toBe(false);

    const inflight = await parked(5, { kind: "sca_required" });
    h.world.mit.lookupAnswers.set(inflight.key, { kind: "pending" });
    const p = await post(`/v1/me/auto-buy/attempts/${inflight.attemptId}/sca-complete`, TOKENS.a);
    expect(p.body).toEqual({ status: "processing", order_group_id: null });
    expect(h.world.store.attemptsAll.find((a) => a.id === inflight.attemptId)?.state).toBe("CHARGING");
  });

  it("an attempt that is not waiting for SCA is a 409 with its state; a PSP lookup outage is a 503", async () => {
    const w = h.world;
    w.catalog.skus.set(SKU(6), quote());
    await w.cancelAll.execute(UU(1), "card_removed");
    const made = await w.create.execute({
      userId: UU(1), skuId: SKU(6), sizeLabel: "M", targetPrice: 64_900n, maxPrice: 70_000n,
      expiresAtMs: w.clock.nowMs() + 30 * 86_400_000, mode: "notify_confirm", pspTokenRef: null, locale: "en", acceptedTermsVersion: 1, deviceId: "d",
    });
    if (made.kind !== "created") throw new Error("arm");
    w.catalog.skus.set(SKU(6), quote({ price: 64_000n }));
    await w.handle.execute({ event_id: "pe-6", sku_id: SKU(6), price: { amount: "64000", currency: "EGP" }, verified: true, anomaly: false, occurred_at: new Date(w.clock.nowMs()).toISOString() });
    const notified = w.store.attemptsAll.find((a) => a.mandateId === made.mandate.id);
    const r = await post(`/v1/me/auto-buy/attempts/${notified?.id}/sca-complete`, TOKENS.a);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "attempt_not_awaiting_sca", state: "NOTIFIED" });

    const sca = await parked(7, { kind: "sca_required" });
    w.mit.lookupThrows = true;
    const down = await post(`/v1/me/auto-buy/attempts/${sca.attemptId}/sca-complete`, TOKENS.a);
    w.mit.lookupThrows = false;
    expect(down.status).toBe(503);
    expect(w.store.attemptsAll.find((a) => a.id === sca.attemptId)?.state).toBe("REQUIRES_USER_ACTION");
  });
});

async function inReview(sku: number): Promise<{ attemptId: string; key: string }> {
  const p = await parked(sku, { kind: "pending" });
  // No saga record and the ceiling passes: the sweep parks it for a human.
  h.world.clock.advance(AUTO_BUY_LIMITS.chargeEscalateMs + 1);
  await h.world.sweep.execute();
  expect(h.world.store.attemptsAll.find((a) => a.id === p.attemptId)?.state).toBe("MANUAL_REVIEW");
  return p;
}
const resolveBody = (over: Record<string, unknown> = {}) => ({
  resolution: "confirm_not_charged",
  psp_reference: "psp-ref-0001",
  evidence_note: "Checked the PSP dashboard: no authorisation exists for this key.",
  ...over,
});

describe("auto-buy MANUAL_REVIEW ops queue", () => {
  it("is ops and finance only: 401 anonymous, wrong audience and no passkey; 403 for support and shoppers", async () => {
    const { attemptId } = await inReview(10);
    const routes: ["get" | "post", string][] = [
      ["get", "/v1/admin/auto-buy/manual-review"],
      ["post", `/v1/admin/auto-buy/manual-review/${attemptId}/resolve`],
    ];
    for (const [method, path] of routes) {
      const call = (t: string | null) => (method === "get" ? get(path, t) : post(path, t, resolveBody()));
      expect((await call(null)).status, `${path} anonymous`).toBe(401);
      expect((await call(TOKENS.a)).status, `${path} shopper token`).toBe(401);
      expect((await call(TOKENS.seller)).status, `${path} seller token`).toBe(401);
      expect((await call(TOKENS.opsBasic)).status, `${path} no passkey`).toBe(403);
      expect((await call(TOKENS.admin)).status, `${path} support role`).toBe(403);
    }
    expect(h.world.store.attemptsAll.find((a) => a.id === attemptId)?.state).toBe("MANUAL_REVIEW");
  });

  it("lists parked attempts oldest first with amounts and the audit entry", async () => {
    const before = h.world.opsAudit.entries.length;
    const r = await get("/v1/admin/auto-buy/manual-review?limit=5", TOKENS.finance);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items[0]).toMatchObject({ state: "MANUAL_REVIEW", mode: "unattended" });
    expect(JSON.stringify(r.body)).not.toMatch(/tok_card|psp_token/);
    expect(h.world.opsAudit.entries.at(-1)).toMatchObject({ action: "auto_buy.manual_review.list", actorId: UU(32) });
    expect(h.world.opsAudit.entries.length).toBe(before + 1);
    expect((await get("/v1/admin/auto-buy/manual-review?limit=500", TOKENS.ops)).status).toBe(400);
  });

  it("confirm_not_charged: audit first, then FAILED, hold released, shopper told; the note is stored only as a digest", async () => {
    const { attemptId } = await inReview(11);
    h.world.inventory.held.add(attemptId);
    const r = await post(`/v1/admin/auto-buy/manual-review/${attemptId}/resolve`, TOKENS.ops, resolveBody());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: attemptId, status: "not_charged", state: "FAILED" });
    const a = h.world.store.attemptsAll.find((x) => x.id === attemptId);
    expect(a).toMatchObject({ state: "FAILED", failureReason: "ops_not_charged:psp-ref-0001" });
    expect(h.world.inventory.held.has(attemptId)).toBe(false);
    const entry = h.world.opsAudit.entries.filter((e) => e.action === "auto_buy.manual_review.resolve").at(-1);
    expect(entry).toMatchObject({ actorId: UU(31), targetId: attemptId, targetType: "auto_buy_attempt", reasonCode: "psp_evidence" });
    expect(entry?.diff["evidence_sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(entry)).not.toContain("Checked the PSP dashboard");
    expect(h.world.store.events.map((e) => e.type)).toContain("auto_buy.manual_review_resolved");
    expect(h.world.notices.sent.at(-1)).toMatchObject({ kind: "not_charged", attemptId });
    // Terminal: a second resolution is refused and changes nothing.
    const again = await post(`/v1/admin/auto-buy/manual-review/${attemptId}/resolve`, TOKENS.finance, resolveBody());
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("attempt_not_in_review");
  });

  it("confirm_purchased needs an order group, closes the rule and records the order once", async () => {
    const { attemptId } = await inReview(12);
    const missing = await post(`/v1/admin/auto-buy/manual-review/${attemptId}/resolve`, TOKENS.finance, resolveBody({ resolution: "confirm_purchased" }));
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe("order_group_required");
    const ok = await post(
      `/v1/admin/auto-buy/manual-review/${attemptId}/resolve`,
      TOKENS.finance,
      resolveBody({ resolution: "confirm_purchased", order_group_id: ORDER }),
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "purchased", state: "PURCHASED", order_group_id: ORDER });
    const a = h.world.store.attemptsAll.find((x) => x.id === attemptId);
    expect(h.world.store.mandatesAll.find((m) => m.id === a?.mandateId)?.status).toBe("PURCHASED");
    expect(h.world.mit.placeCalls.filter((c) => c.holdKey === attemptId)).toHaveLength(1);
  });

  it("refuses a resolution the PSP lookup contradicts", async () => {
    const late = await inReview(13);
    h.world.mit.placed.set(late.key, ORDER);
    const notCharged = await post(`/v1/admin/auto-buy/manual-review/${late.attemptId}/resolve`, TOKENS.ops, resolveBody());
    expect(notCharged.status).toBe(409);
    expect(notCharged.body.code).toBe("evidence_conflict");

    const failed = await inReview(14);
    h.world.mit.lookupAnswers.set(failed.key, { kind: "failed" });
    const purchased = await post(
      `/v1/admin/auto-buy/manual-review/${failed.attemptId}/resolve`,
      TOKENS.ops,
      resolveBody({ resolution: "confirm_purchased", order_group_id: ORDER }),
    );
    expect(purchased.status).toBe(409);
    expect(purchased.body.code).toBe("evidence_conflict");
    expect(h.world.store.attemptsAll.find((a) => a.id === failed.attemptId)?.state).toBe("MANUAL_REVIEW");
  });

  it("validates strictly, never acts when the audit write fails, and 404s an unknown attempt", async () => {
    const { attemptId } = await inReview(15);
    const path = `/v1/admin/auto-buy/manual-review/${attemptId}/resolve`;
    for (const bad of [
      resolveBody({ resolution: "refund" }),
      resolveBody({ psp_reference: "x" }),
      resolveBody({ psp_reference: "has spaces in it" }),
      resolveBody({ evidence_note: "short" }),
      resolveBody({ order_group_id: "nope" }),
      resolveBody({ user_id: UU(1) }),
    ]) {
      expect((await post(path, TOKENS.ops, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    h.world.opsAudit.failNext = true;
    expect((await post(path, TOKENS.ops, resolveBody())).status).toBe(503);
    expect(h.world.store.attemptsAll.find((a) => a.id === attemptId)?.state).toBe("MANUAL_REVIEW");
    expect((await post(`/v1/admin/auto-buy/manual-review/${UU(998)}/resolve`, TOKENS.ops, resolveBody())).status).toBe(404);
    tick();
    expect((await h.http().post(path).set(bearer(TOKENS.ops)).send(resolveBody())).status).toBe(400);
  });
});
