import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADDRESS, OTHER_SHOPPER, SHOPPER, U } from "./world";
import { createCheckoutHarness, shopperActor, type CheckoutHarness } from "./harness";

let h: CheckoutHarness;
const KEY = (n: number): string => `0192f3a4-5b6c-7d8e-9f00-${String(n).padStart(12, "0")}`;
const auth = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` });

beforeEach(async () => {
  h = await createCheckoutHarness();
  h.tokens.add("shopper-token-000001", shopperActor(SHOPPER));
  h.tokens.add("other-token-0000000001", shopperActor(OTHER_SHOPPER));
});
afterEach(async () => {
  await h.close();
});

const body = (over: Record<string, unknown> = {}) => ({ method: "card", address_id: ADDRESS, use_store_credit: false, ...over });

describe("POST /v1/checkout/quote", () => {
  it("requires authentication", async () => {
    await h.http().post("/v1/checkout/quote").send(body()).expect(401);
  });

  it("returns every fee and method on the first render and writes nothing", async () => {
    const r = await h.http().post("/v1/checkout/quote").set(auth("shopper-token-000001")).send(body()).expect(200);
    expect(r.body.total).toEqual({ amount: "238000", currency: "EGP" });
    expect(r.body.stores).toHaveLength(2);
    expect(r.body.stores[0].delivery_fee).toEqual({ amount: "4000", currency: "EGP" });
    expect(r.body.methods.map((m: { method: string }) => m.method)).toContain("cod");
    expect(typeof r.body.price_lock.token).toBe("string");
    expect(h.world.inventory.activeReservations()).toBe(0);
  });

  it("rejects unknown fields and bad methods (Zod at the boundary)", async () => {
    await h.http().post("/v1/checkout/quote").set(auth("shopper-token-000001")).send({ ...body(), total: "1" }).expect(400);
    await h.http().post("/v1/checkout/quote").set(auth("shopper-token-000001")).send(body({ method: "bitcoin" })).expect(400);
  });

  it("an address that is not the caller's is a 404", async () => {
    await h.http().post("/v1/checkout/quote").set(auth("shopper-token-000001")).send(body({ address_id: U(799) })).expect(404);
  });
});

describe("POST /v1/checkout", () => {
  it("needs an Idempotency-Key (400) and an account (401)", async () => {
    await h.http().post("/v1/checkout").send(body()).expect(401);
    await h.http().post("/v1/checkout").set(auth("shopper-token-000001")).send(body()).expect(400);
  });

  it("places a saga, returns the client action, and replays the same key to the same OrderGroup", async () => {
    const a = await h.http().post("/v1/checkout").set(auth("shopper-token-000001")).set("idempotency-key", KEY(1)).send(body()).expect(200);
    expect(a.body.status).toBe("await_payment");
    expect(a.body.client_action.type).toBe("redirect");
    const b = await h.http().post("/v1/checkout").set(auth("shopper-token-000001")).set("idempotency-key", KEY(1)).send(body()).expect(200);
    expect(b.body.order_group_id).toBe(a.body.order_group_id);
    expect(h.world.provider.createIntentCalls).toBe(1);
    await h.http().post("/v1/checkout").set(auth("shopper-token-000001")).set("idempotency-key", KEY(1)).send(body({ method: "meeza" })).expect(422);
  });

  it("price change since the confirmed total is a 409 with the delta and a fresh lock", async () => {
    const r = await h
      .http()
      .post("/v1/checkout")
      .set(auth("shopper-token-000001"))
      .set("idempotency-key", KEY(2))
      .send(body({ expected_total: "230000" }))
      .expect(409);
    expect(r.body.code).toBe("price_changed");
    expect(r.body.delta).toBe("8000");
    expect(typeof r.body.price_lock).toBe("string");
  });

  it("stock shortfall is a 409 insufficient_stock with a pointer per SKU", async () => {
    h.world.inventory.setStock(U(502), 0);
    const r = await h.http().post("/v1/checkout").set(auth("shopper-token-000001")).set("idempotency-key", KEY(3)).send(body()).expect(409);
    expect(r.body.code).toBe("insufficient_stock");
    expect(r.body.errors[0].pointer).toBe(`/skus/${U(502)}`);
  });

  it("COD blocked by risk is 409 method_unavailable", async () => {
    h.world.risk.decision = { kind: "block" };
    const r = await h.http().post("/v1/checkout").set(auth("shopper-token-000001")).set("idempotency-key", KEY(4)).send(body({ method: "cod" })).expect(409);
    expect(r.body.code).toBe("method_unavailable");
    expect(r.body.reason).toBe("risk_blocked");
  });
});

describe("authorization on checkout groups", () => {
  it("owner reads and cancels; another shopper gets 404 (BOLA); unknown id is 404; no token is 401", async () => {
    const a = await h.http().post("/v1/checkout").set(auth("shopper-token-000001")).set("idempotency-key", KEY(5)).send(body()).expect(200);
    const id = a.body.order_group_id as string;
    await h.http().get(`/v1/checkout/${id}`).set(auth("shopper-token-000001")).expect(200);
    await h.http().get(`/v1/checkout/${id}`).set(auth("other-token-0000000001")).expect(404);
    await h.http().get(`/v1/checkout/${U(9999)}`).set(auth("shopper-token-000001")).expect(404);
    await h.http().get(`/v1/checkout/${id}`).expect(401);
    await h.http().post(`/v1/checkout/${id}/cancel`).set(auth("other-token-0000000001")).set("idempotency-key", KEY(6)).send({}).expect(404);
    const c = await h.http().post(`/v1/checkout/${id}/cancel`).set(auth("shopper-token-000001")).set("idempotency-key", KEY(7)).send({}).expect(200);
    expect(c.body.status).toBe("cancelled");
    expect(h.world.inventory.activeReservations()).toBe(0);
  });

  it("confirm-cod: wrong code is 422, foreign shopper 404, right code places", async () => {
    h.world.risk.decision = { kind: "require_confirmation" };
    const a = await h.http().post("/v1/checkout").set(auth("shopper-token-000001")).set("idempotency-key", KEY(8)).send(body({ method: "cod" })).expect(200);
    expect(a.body.state).toBe("awaiting_confirmation");
    const id = a.body.order_group_id as string;
    await h.http().post(`/v1/checkout/${id}/confirm-cod`).set(auth("other-token-0000000001")).set("idempotency-key", KEY(9)).send({ code: "123456" }).expect(404);
    await h.http().post(`/v1/checkout/${id}/confirm-cod`).set(auth("shopper-token-000001")).set("idempotency-key", KEY(10)).send({ code: "000000" }).expect(422);
    const ok = await h.http().post(`/v1/checkout/${id}/confirm-cod`).set(auth("shopper-token-000001")).set("idempotency-key", KEY(11)).send({ code: "123456" }).expect(200);
    expect(ok.body.status).toBe("placed");
  });
});

describe("POST /v1/webhooks/checkout/:provider", () => {
  it("verifies the HMAC over the raw body, places the order once, and treats redelivery as a no-op", async () => {
    const a = await h.http().post("/v1/checkout").set(auth("shopper-token-000001")).set("idempotency-key", KEY(12)).send(body()).expect(200);
    const g = a.body.order_group_id as string;
    h.world.provider.markSucceeded(`pi_${g}`);
    const e = h.world.provider.webhook({ eventId: "evt-http", intentId: `pi_${g}`, orderGroupId: g, kind: "succeeded", amount: 238_000n });
    const send = (headers: Record<string, string>) =>
      h.http().post("/v1/webhooks/checkout/fake-psp").set(headers).set("content-type", "application/json").send(e.rawBody);
    await send({ "x-fake-signature": "forged" }).expect(400);
    await send(e.headers).expect(200);
    await send(e.headers).expect(200);
    expect(h.world.orders.placed.size).toBe(1);
    expect((await h.world.repo.get(g))?.facts.status).toBe("PLACED");
    await h.http().post("/v1/webhooks/checkout/unknown-psp").set("content-type", "application/json").send("{}").expect(404);
    // The owner sees it placed; nobody else can.
    const s = await h.http().get(`/v1/checkout/${g}`).set(auth("shopper-token-000001")).expect(200);
    expect(s.body.status).toBe("placed");
  });
});
