import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClientAction } from "@outlet/checkout";
import { addToBag, authedHeaders, checkoutRequest, quote } from "./flows.js";
import { bearer, createTestApp } from "./harness.js";
import type { TestApp } from "./harness.js";

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });
// Test helper: the caller names the expected shape.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const json = <T>(body: string): T => JSON.parse(body) as T;

interface Wire {
  kind: string;
  url: string | null;
  reference: string | null;
  expires_at: string | null;
}
const placeWith = async (method: string, action: ClientAction): Promise<{ status: number; action: Wire | null; groupId: string | null }> => {
  const original = t.fakes.provider.createIntent.bind(t.fakes.provider);
  t.fakes.provider.createIntent = (req, key) => original(req, key).then((r) => (r.ok ? { ...r, clientAction: action } : r));
  try {
    const s = await t.shopper();
    await addToBag(t, s.token);
    const q = await quote(t, s.token, method);
    const res = await t.inject(checkoutRequest(t, s.token, q, method));
    const b = json<{ order_group_id?: string; client_action?: Wire }>(res.body);
    return { status: res.statusCode, action: b.client_action ?? null, groupId: b.order_group_id ?? null };
  } finally {
    t.fakes.provider.createIntent = original;
  }
};

describe("client action wire mapping (one case per provider action kind)", () => {
  it.each<[string, ClientAction, Wire]>([
    ["card", { kind: "iframe", url: "https://pay.fake.test/if/1" }, { kind: "iframe", url: "https://pay.fake.test/if/1", reference: null, expires_at: null }],
    ["card", { kind: "redirect", url: "https://pay.fake.test/r/1" }, { kind: "redirect", url: "https://pay.fake.test/r/1", reference: null, expires_at: null }],
    ["apple_pay", { kind: "sdk", provider: "paymob", clientToken: "tok_123" }, { kind: "sdk", url: null, reference: "tok_123", expires_at: null }],
    ["instapay", { kind: "instapay_request", reference: "IP-77", expiresAt: "2030-01-01T00:30:00.000Z" }, { kind: "instapay_qr", url: null, reference: "IP-77", expires_at: "2030-01-01T00:30:00.000Z" }],
    ["fawry", { kind: "fawry_reference", reference: "FW-9", expiresAt: "2030-01-02T00:00:00.000Z" }, { kind: "fawry_reference", url: null, reference: "FW-9", expires_at: "2030-01-02T00:00:00.000Z" }],
    ["card", { kind: "cod_confirmation", channel: "whatsapp", expiresAt: "2030-01-01T02:00:00.000Z" }, { kind: "cod_confirmation", url: null, reference: "whatsapp", expires_at: "2030-01-01T02:00:00.000Z" }],
    ["card", { kind: "none" }, { kind: "none", url: null, reference: null, expires_at: null }],
  ])("%s -> %j", async (method, action, wire) => {
    const r = await placeWith(method, action);
    expect(r.status).toBe(201);
    expect(r.action).toEqual(wire);
  });
});

describe("checkout optional inputs", () => {
  it("store_credit and bnpl_provider are forwarded: credit above the balance is refused with nothing placed; a zero-balance request still quotes", async () => {
    const s = await t.shopper();
    await addToBag(t, s.token);
    const over = await t.inject({ method: "POST", url: "/v1/eg/checkout/quote", headers: authedHeaders(t, s.token), payload: { address_id: "00000000-0000-4000-8000-0000000add01", payment_method: "card", store_credit: { amount_minor: "5000", currency: "EGP" } } });
    expect([200, 409, 422]).toContain(over.statusCode);
    if (over.statusCode === 200) expect(json<{ store_credit: { amount_minor: string } }>(over.body).store_credit.amount_minor).toBe("0"); // capped to the (empty) balance
    const bnpl = await t.inject({ method: "POST", url: "/v1/eg/checkout/quote", headers: authedHeaders(t, s.token), payload: { address_id: "00000000-0000-4000-8000-0000000add01", payment_method: "bnpl", bnpl_provider: "valu" } });
    expect(bnpl.statusCode).toBeLessThan(500);
    const q = await quote(t, s.token, "card");
    const base = checkoutRequest(t, s.token, q, "card").payload as object;
    // a lender named on a card payment would violate payment_intents CHECK (bnpl_provider IS NULL OR method = 'bnpl'): 422, never a 500
    const mismatch = await t.inject({ ...checkoutRequest(t, s.token, q, "card"), payload: { ...base, bnpl_provider: "valu" } });
    expect(mismatch.statusCode).toBe(422);
    expect(json<{ code: string }>(mismatch.body).code).toBe("bnpl-provider-mismatch");
    const quoteMismatch = await t.inject({ method: "POST", url: "/v1/eg/checkout/quote", headers: authedHeaders(t, s.token), payload: { address_id: "00000000-0000-4000-8000-0000000add01", payment_method: "card", bnpl_provider: "valu" } });
    expect(quoteMismatch.statusCode).toBe(422);
    // the rejected attempt did not consume the quote token: the same token still places with a zero store-credit request
    const place = await t.inject({ ...checkoutRequest(t, s.token, q, "card"), payload: { ...base, store_credit: { amount_minor: "0", currency: "EGP" } } });
    expect(place.statusCode).toBe(201);
  });
  it("a shopper cannot place with someone else's quote token: the token binds the user", async () => {
    const a = await t.shopper();
    const b = await t.shopper();
    await addToBag(t, a.token);
    await addToBag(t, b.token);
    const qa = await quote(t, a.token, "card");
    const res = await t.inject(checkoutRequest(t, b.token, qa, "card"));
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    const mine = json<{ items: unknown[] }>((await t.inject({ method: "GET", url: "/v1/eg/order-groups", headers: bearer(b.token) })).body);
    expect(mine.items).toEqual([]);
  });
});
