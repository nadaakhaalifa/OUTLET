import { afterEach, describe, expect, it } from "vitest";
import { StaticIpAllowList } from "../adapters/ip-allowlist";
import { GROUP_1, SHOPPER_A, SHOPPER_B, cardRecord, intentRecord } from "./fixtures";
import { createPaymentsHarness, shopperActor } from "./harness";
import { webhookBody } from "./world";

type H = Awaited<ReturnType<typeof createPaymentsHarness>>;
let h: H | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const post = (x: H, body: Record<string, unknown>, headers: Record<string, string>) => {
  let r = x.http().post("/v1/webhooks/fake_psp").set("Content-Type", "application/json");
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(body);
};

describe("POST /v1/webhooks/{provider}", () => {
  it("stores a verified event, answers 200 and enqueues processing; replay answers 200 without a second event", async () => {
    h = await createPaymentsHarness();
    const body = webhookBody("payment.authorized", { event_id: "evt_http_1" });
    const signed = h.provider.signedWebhook(body);
    const a = await post(h, body, signed.headers);
    const b = await post(h, body, signed.headers);
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ received: true });
    expect(b.status).toBe(200);
    expect(h.store.allRawEvents()).toHaveLength(1);
    expect(h.store.outboxTypes()).toEqual(["payment.webhook_received"]);
  });

  it("answers 200 for a bad signature after storing the evidence, and never processes it", async () => {
    h = await createPaymentsHarness();
    const body = webhookBody("payment.succeeded", { event_id: "evt_http_2" });
    const res = await post(h, body, { "x-fake-signature": "00".repeat(32), "x-fake-timestamp": String(h.clock.nowMs()) });
    expect(res.status).toBe(200);
    expect(h.store.allRawEvents()[0]).toMatchObject({ signatureOk: false, rejectReason: "bad_signature" });
    expect(h.store.outboxTypes()).toEqual([]);
  });

  it("answers 200 with no signature headers at all", async () => {
    h = await createPaymentsHarness();
    const res = await post(h, webhookBody("payment.succeeded"), {});
    expect(res.status).toBe(200);
    expect(h.store.allRawEvents()[0]?.rejectReason).toBe("missing_signature");
  });

  it("verifies against the raw bytes: re-ordered JSON with the same meaning is not authentic", async () => {
    h = await createPaymentsHarness();
    const body = webhookBody("payment.authorized", { event_id: "evt_http_3" });
    const signed = h.provider.signedWebhook(body);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(body).reverse()));
    const res = await h
      .http()
      .post("/v1/webhooks/fake_psp")
      .set("Content-Type", "application/json")
      .set(signed.headers)
      .send(reordered);
    expect(res.status).toBe(200);
    expect(h.store.allRawEvents()[0]?.signatureOk).toBe(false);
  });

  it("404 for an unknown provider, nothing stored", async () => {
    h = await createPaymentsHarness();
    const res = await h.http().post("/v1/webhooks/unknown_psp").send({});
    expect(res.status).toBe(404);
    expect(h.store.allRawEvents()).toHaveLength(0);
  });

  it("404 for a malformed provider path segment (injection guard)", async () => {
    h = await createPaymentsHarness();
    const res = await h.http().post("/v1/webhooks/..%2Fadmin").send({});
    expect([400, 404]).toContain(res.status);
  });

  it("403 when the source IP is not on the provider allow-list; nothing stored", async () => {
    h = await createPaymentsHarness({ ipAllowList: new StaticIpAllowList({ fake_psp: ["203.0.113.9"] }) });
    const body = webhookBody("payment.authorized", { event_id: "evt_http_4" });
    const res = await post(h, body, h.provider.signedWebhook(body).headers);
    expect(res.status).toBe(403);
    expect(h.store.allRawEvents()).toHaveLength(0);
  });

  it("answers 5xx rather than trusting a body whose raw bytes were not captured", async () => {
    h = await createPaymentsHarness({ rawBody: false });
    const body = webhookBody("payment.authorized", { event_id: "evt_http_5" });
    const res = await post(h, body, h.provider.signedWebhook(body).headers);
    expect(res.status).toBe(500);
    expect(h.store.allRawEvents()).toHaveLength(0);
  });

  it("end to end: a signed success moves the intent after the consumer runs, without any user token", async () => {
    h = await createPaymentsHarness();
    const i = intentRecord({ orderGroupId: GROUP_1, status: "REQUIRES_ACTION", providerRef: "pi_http", userId: SHOPPER_A });
    await h.store.insertIntent(i, []);
    const body = webhookBody("payment.succeeded", { provider_ref: "pi_http", order_group_id: GROUP_1, event_id: "evt_http_6" });
    expect((await post(h, body, h.provider.signedWebhook(body).headers)).status).toBe(200);
    expect((await h.store.getIntent(i.id))?.status).toBe("REQUIRES_ACTION");
    await h.processor.drain(10);
    expect((await h.store.getIntent(i.id))?.status).toBe("SUCCEEDED");
  });
});

describe("shopper routes", () => {
  const login = (x: H) => {
    x.tokens.add("token-shopper-a-000000001", { actor: shopperActor(SHOPPER_A), aud: "buyer_api" });
    x.tokens.add("token-shopper-b-000000001", { actor: shopperActor(SHOPPER_B), aud: "buyer_api" });
    x.tokens.add("token-seller-aud-0000001", { actor: shopperActor(SHOPPER_A), aud: "seller_api" });
  };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it("requires authentication on every shopper route", async () => {
    h = await createPaymentsHarness();
    expect((await h.http().get("/v1/payments/methods?amount=100")).status).toBe(401);
    expect((await h.http().get("/v1/me/payment-methods")).status).toBe(401);
    expect((await h.http().delete(`/v1/me/payment-methods/${SHOPPER_A}`)).status).toBe(401);
  });

  it("rejects a token minted for another audience", async () => {
    h = await createPaymentsHarness();
    login(h);
    const res = await h.http().get("/v1/me/payment-methods").set(auth("token-seller-aud-0000001"));
    expect([401, 403]).toContain(res.status);
  });

  it("lists availability with Fawry metadata and honours kill switches and drop SKUs", async () => {
    h = await createPaymentsHarness();
    login(h);
    const res = await h.http().get("/v1/payments/methods?amount=100000&contains_drop_sku=true").set(auth("token-shopper-a-000000001"));
    expect(res.status).toBe(200);
    const fawry = res.body.methods.find((m: { id: string }) => m.id === "fawry");
    expect(fawry).toMatchObject({ available: false, unavailable_reason: "drop_sku_not_allowed", stock_pool: "non_drop", reference_expires_in_seconds: 86_400 });
    h.sw.disable("card");
    const killed = await h.http().get("/v1/payments/methods?amount=100000").set(auth("token-shopper-a-000000001"));
    expect(killed.body.methods.find((m: { id: string }) => m.id === "meeza")).toMatchObject({ available: false, unavailable_reason: "kill_switch" });
  });

  it("validates the query (strict, no unknown params)", async () => {
    h = await createPaymentsHarness();
    login(h);
    expect((await h.http().get("/v1/payments/methods?amount=-5").set(auth("token-shopper-a-000000001"))).status).toBe(400);
    expect((await h.http().get("/v1/payments/methods?amount=5&x=1").set(auth("token-shopper-a-000000001"))).status).toBe(400);
  });

  it("saved cards: display fields only, never the token or fingerprint, and strictly owner scoped", async () => {
    h = await createPaymentsHarness();
    login(h);
    const card = cardRecord({ userId: SHOPPER_A });
    await h.store.upsertSavedCard(card);
    const mine = await h.http().get("/v1/me/payment-methods").set(auth("token-shopper-a-000000001"));
    expect(mine.status).toBe(200);
    expect(mine.body.items).toEqual([{ id: card.id, brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 }]);
    expect(JSON.stringify(mine.body)).not.toContain(card.pspToken);
    expect(JSON.stringify(mine.body)).not.toContain(card.fingerprint);
    const theirs = await h.http().get("/v1/me/payment-methods").set(auth("token-shopper-b-000000001"));
    expect(theirs.body.items).toEqual([]);
  });

  it("negative authorization: shopper B deleting shopper A's card gets 404 and the card survives", async () => {
    h = await createPaymentsHarness();
    login(h);
    const card = cardRecord({ userId: SHOPPER_A });
    await h.store.upsertSavedCard(card);
    const res = await h.http().delete(`/v1/me/payment-methods/${card.id}`).set(auth("token-shopper-b-000000001"));
    expect(res.status).toBe(404);
    expect(h.provider.deletedTokens).toEqual([]);
    expect(await h.store.getSavedCard(card.id, SHOPPER_A)).not.toBeNull();
    const ok = await h.http().delete(`/v1/me/payment-methods/${card.id}`).set(auth("token-shopper-a-000000001"));
    expect(ok.status).toBe(204);
    expect(h.provider.deletedTokens).toEqual([card.pspToken]);
    expect((await h.http().delete(`/v1/me/payment-methods/${card.id}`).set(auth("token-shopper-a-000000001"))).status).toBe(404);
  });

  it("a malformed id is a validation error, not a lookup", async () => {
    h = await createPaymentsHarness();
    login(h);
    expect((await h.http().delete("/v1/me/payment-methods/not-a-uuid").set(auth("token-shopper-a-000000001"))).status).toBe(400);
  });

  it("a PSP outage while deleting keeps the card and answers 503", async () => {
    h = await createPaymentsHarness();
    login(h);
    const card = cardRecord({ userId: SHOPPER_A });
    await h.store.upsertSavedCard(card);
    h.provider.failNext("delete_token", { kind: "timeout" }, 3);
    const res = await h.http().delete(`/v1/me/payment-methods/${card.id}`).set(auth("token-shopper-a-000000001"));
    expect(res.status).toBe(503);
    expect(await h.store.getSavedCard(card.id, SHOPPER_A)).not.toBeNull();
  });
});
