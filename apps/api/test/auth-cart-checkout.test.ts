import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PasskeyStrongAuth } from "../src/modules/auth/index.js";
import { ADDRESS, addToBag, assertVerifyRequest, authedHeaders, checkoutRequest, enrollPasskey, phone, placeOrder, quote, signIn } from "./flows.js";
import { bearer, createTestApp, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";
import { webhookFor } from "./route-fixtures.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

// Test helper: the caller names the expected shape.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const json = <T = unknown>(body: string): T => JSON.parse(body) as T;
const otpReq = (device: string, p: string) => ({ method: "POST" as const, url: "/v1/eg/auth/otp/request", headers: { "x-device-id": device, "idempotency-key": idemKey(t) }, payload: { phone_e164: p, channel: "sms", purpose: "sign_in" } });

describe("auth: OTP", () => {
  it("rate limits a phone to 3 requests per 15 minutes with Retry-After (429)", async () => {
    const device = await t.device();
    const p = phone();
    for (let i = 0; i < 3; i++) expect((await t.inject(otpReq(device, p))).statusCode).toBe(201);
    const res = await t.inject(otpReq(device, p));
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(json<{ code: string }>(res.body).code).toBe("rate-limited");
  });

  it("fails closed without X-Device-Id and refuses non-Egyptian numbers and WhatsApp", async () => {
    const noDevice = await t.inject({ ...otpReq("x", phone()), headers: { "idempotency-key": idemKey(t) } });
    expect(noDevice.statusCode).toBe(400);
    expect(json<{ code: string }>(noDevice.body).code).toBe("device-id-required");
    const foreign = await t.inject(otpReq(await t.device(), "+14155550123"));
    expect(foreign.statusCode).toBe(422);
    expect(json<{ code: string }>(foreign.body).code).toBe("unsupported-country");
    const wa = await t.inject({ ...otpReq(await t.device(), phone()), payload: { phone_e164: phone(), channel: "whatsapp", purpose: "sign_in" } });
    expect(wa.statusCode).toBe(422);
  });

  it("locks a code after 5 wrong attempts, then even the right code is refused", async () => {
    const device = await t.device();
    const p = phone();
    const { challenge_id } = json<{ challenge_id: string }>((await t.inject(otpReq(device, p))).body);
    const code = t.sms.last();
    const verify = (c: string) => t.inject({ method: "POST", url: "/v1/eg/auth/otp/verify", headers: { "x-device-id": device, "idempotency-key": idemKey(t) }, payload: { challenge_id, phone_e164: p, code: c, dob: "1990-01-01" } });
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await verify(wrong)).statusCode).toBe(400);
    expect((await verify(code)).statusCode).toBe(429);
  });

  it("verify sets an HttpOnly Secure SameSite refresh cookie and returns the token pair", async () => {
    const device = await t.device();
    const p = phone();
    const { challenge_id } = json<{ challenge_id: string }>((await t.inject(otpReq(device, p))).body);
    const res = await t.inject({ method: "POST", url: "/v1/eg/auth/otp/verify", headers: { "x-device-id": device, "idempotency-key": idemKey(t) }, payload: { challenge_id, phone_e164: p, code: t.sms.last(), dob: "1990-01-01" } });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(json<{ token_type: string; is_new_user: boolean; amr: string[] }>(res.body)).toMatchObject({ token_type: "Bearer", is_new_user: true, amr: ["otp"] });
  });

  it("a same-key replay of a token-issuing route is 409 idempotent-replay-unavailable and no token is stored", async () => {
    const device = await t.device();
    const p = phone();
    const { challenge_id } = json<{ challenge_id: string }>((await t.inject(otpReq(device, p))).body);
    const key = idemKey(t);
    const verify = () => t.inject({ method: "POST", url: "/v1/eg/auth/otp/verify", headers: { "x-device-id": device, "idempotency-key": key }, payload: { challenge_id, phone_e164: p, code: t.sms.last(), dob: "1990-01-01" } });
    const first = await verify();
    expect(first.statusCode).toBe(200);
    const replay = await verify();
    expect([replay.statusCode, json<{ code: string }>(replay.body).code]).toEqual([409, "idempotent-replay-unavailable"]);
    expect(replay.body).not.toContain(json<{ refresh_token?: string }>(first.body).refresh_token ?? "no-token");
    const rows = await t.raw.query<{ response_status: number; response_body: unknown }>("SELECT response_status, response_body FROM idempotency_keys WHERE key = $1", [key]);
    expect(rows.rows).toEqual([{ response_status: 200, response_body: { response_redacted: true } }]);
    expect(JSON.stringify(rows.rows)).not.toMatch(/access_token|refresh_token/);
  });

  it("refuses an under-18 date of birth without creating an account", async () => {
    const device = await t.device();
    const p = phone();
    const { challenge_id } = json<{ challenge_id: string }>((await t.inject(otpReq(device, p))).body);
    const res = await t.inject({ method: "POST", url: "/v1/eg/auth/otp/verify", headers: { "x-device-id": device, "idempotency-key": idemKey(t) }, payload: { challenge_id, phone_e164: p, code: t.sms.last(), dob: "2020-01-01" } });
    expect(res.statusCode).toBe(403);
    expect(json<{ code: string }>(res.body).code).toBe("under-age");
  });
});

describe("auth: refresh, logout, sessions", () => {
  it("rotates the refresh token, and reuse revokes the whole family (401)", async () => {
    const s = await signIn(t);
    const refresh = (token: string) => t.inject({ method: "POST", url: "/v1/eg/auth/refresh", headers: { "x-device-id": s.deviceId, "idempotency-key": idemKey(t) }, payload: { refresh_token: token } });
    const first = await refresh(s.refresh);
    expect(first.statusCode).toBe(200);
    const next = json<{ refresh_token: string }>(first.body).refresh_token;
    expect(next).not.toBe(s.refresh);
    t.clock.now += 11_000; // past the 10 s grace window (finding 3)
    const reuse = await refresh(s.refresh);
    expect(reuse.statusCode).toBe(401);
    expect(json<{ code: string }>(reuse.body).code).toBe("refresh-rejected");
    // The family is dead: the newest token no longer works either.
    expect((await refresh(next)).statusCode).toBe(401);
  });

  it("a refresh token presented from another device revokes the family", async () => {
    const s = await signIn(t);
    const other = await t.device();
    const res = await t.inject({ method: "POST", url: "/v1/eg/auth/refresh", headers: { "x-device-id": other, "idempotency-key": idemKey(t) }, payload: { refresh_token: s.refresh } });
    expect(res.statusCode).toBe(401);
  });

  it("refresh falls back to the cookie when the body carries no token", async () => {
    const s = await signIn(t);
    const res = await t.inject({ method: "POST", url: "/v1/eg/auth/refresh", headers: { "x-device-id": s.deviceId, "idempotency-key": idemKey(t), cookie: `__Secure-outlet_rt=${s.refresh}` }, payload: {} });
    expect(res.statusCode).toBe(200);
    const none = await t.inject({ method: "POST", url: "/v1/eg/auth/refresh", headers: { "x-device-id": s.deviceId, "idempotency-key": idemKey(t) }, payload: {} });
    expect(none.statusCode).toBe(401);
  });

  it("lists my sessions marking the current one, and logout revokes it and clears the cookie", async () => {
    const s = await signIn(t);
    const list = await t.inject({ method: "GET", url: "/v1/eg/me/sessions", headers: bearer(s.token) });
    expect(json<{ items: { id: string; current: boolean; platform: string }[] }>(list.body).items).toEqual([expect.objectContaining({ id: s.sessionId, current: true, platform: "web" })]);
    const out = await t.inject({ method: "POST", url: "/v1/eg/auth/logout", headers: authedHeaders(t, s.token), payload: {} });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
    const after = await t.inject({ method: "GET", url: "/v1/eg/me/sessions", headers: bearer(s.token) });
    expect(json<{ items: unknown[] }>(after.body).items).toEqual([]);
    const refresh = await t.inject({ method: "POST", url: "/v1/eg/auth/refresh", headers: { "x-device-id": s.deviceId, "idempotency-key": idemKey(t) }, payload: { refresh_token: s.refresh } });
    expect(refresh.statusCode).toBe(401);
  });
});

describe("auth: passkeys and the strong-auth gate", () => {
  it("enrols a credential, signs in with amr passkey and records the counter", async () => {
    const s = await signIn(t);
    const authn = await enrollPasskey(t, s);
    const device = await t.device();
    const res = await t.inject(await assertVerifyRequest(t, authn, device));
    expect(res.statusCode).toBe(200);
    expect(json<{ amr: string[]; user_id: string }>(res.body)).toMatchObject({ amr: ["passkey"], user_id: s.userId });
    const stored = await t.passkeyStore.findByCredentialId("EG", authn.id);
    expect(stored?.counter).toBe(1);
    expect(stored?.lastUsedAt).not.toBeNull();
  });

  it("a ceremony cannot be replayed: the challenge is single use", async () => {
    const s = await signIn(t);
    const authn = await enrollPasskey(t, s);
    const device = await t.device();
    const req = await assertVerifyRequest(t, authn, device);
    expect((await t.inject(req)).statusCode).toBe(200);
    const again = await t.inject({ ...req, headers: { ...(req.headers as Record<string, string>), "idempotency-key": idemKey(t) } });
    expect(again.statusCode).toBe(422);
  });

  it("rejects an assertion from the wrong origin and a replayed (non-increasing) counter", async () => {
    const s = await signIn(t);
    const authn = await enrollPasskey(t, s);
    const device = await t.device();
    expect((await t.inject(await assertVerifyRequest(t, authn, device, { origin: "https://evil.test" }))).statusCode).toBe(401);
    expect((await t.inject(await assertVerifyRequest(t, authn, device))).statusCode).toBe(200);
    expect((await t.inject(await assertVerifyRequest(t, authn, device, { counter: 1 }))).statusCode).toBe(401);
  });

  it("an unknown credential is indistinguishable from a bad signature (401)", async () => {
    const s = await signIn(t);
    const authn = await enrollPasskey(t, s);
    const stranger = await enrollPasskey(t, await signIn(t));
    const device = await t.device();
    const req = await assertVerifyRequest(t, stranger, device);
    const body = req.payload as { credential: { id: string } };
    body.credential.id = authn.id.slice(0, -2) + "AA";
    expect((await t.inject(req)).statusCode).toBe(401);
  });

  it("PasskeyStrongAuth verifies enrolment only for the owning user and never for TOTP", async () => {
    const s = await signIn(t);
    const authn = await enrollPasskey(t, s);
    const gate = new PasskeyStrongAuth(t.passkeyStore, "EG");
    expect(await gate.verifyEnrollment({ userId: s.userId, method: "passkey", proof: authn.id })).toBe(true);
    expect(await gate.verifyEnrollment({ userId: randomUUID(), method: "passkey", proof: authn.id })).toBe(false);
    expect(await gate.verifyEnrollment({ userId: s.userId, method: "passkey", proof: "nope" })).toBe(false);
    expect(await gate.verifyEnrollment({ userId: s.userId, method: "totp", proof: authn.id })).toBe(false);
  });

  it("a passkey session satisfies the seller-route gate (amr passkey) while an OTP session does not", async () => {
    const s = await signIn(t);
    const authn = await enrollPasskey(t, s);
    t.memberships.grant("EG", s.userId, t.seed.storeA, ["catalog"]);
    const pk = json<{ access_token: string }>((await t.inject(await assertVerifyRequest(t, authn, await t.device()))).body).access_token;
    const sellerGet = (token: string) => t.inject({ method: "GET", url: "/v1/eg/seller/products?limit=5", headers: { ...bearer(token), "x-store-id": t.seed.storeA } });
    expect((await sellerGet(pk)).statusCode).toBe(200);
    const otp = await sellerGet(s.token);
    expect(otp.statusCode).toBe(403);
    expect(json<{ code: string }>(otp.body).code).toBe("passkey-required");
  });
});

describe("cart", () => {
  it("merges quantities, enforces the 10-unit limit and shows honest plain prices", async () => {
    const s = await t.shopper();
    await addToBag(t, s.token, 3);
    const merged = await t.inject({ method: "POST", url: "/v1/eg/cart/lines", headers: authedHeaders(t, s.token), payload: { sku_id: t.seed.skuA, qty: 4 } });
    const cart = json<{ groups: { lines: { qty: number; current_price: { claim_type: string } }[]; remaining_for_free_delivery: { amount_minor: string } }[] }>(merged.body);
    expect(cart.groups[0]?.lines[0]?.qty).toBe(7);
    expect(cart.groups[0]?.lines[0]?.current_price.claim_type).toBe("plain");
    const over = await t.inject({ method: "POST", url: "/v1/eg/cart/lines", headers: authedHeaders(t, s.token), payload: { sku_id: t.seed.skuA, qty: 4 } });
    expect(over.statusCode).toBe(422);
    expect(json<{ code: string }>(over.body).code).toBe("qty-limit");
  });

  it("replays an idempotent add without adding twice, and rejects the same key with another body", async () => {
    const s = await t.shopper();
    const key = idemKey(t);
    const add = (qty: number) => t.inject({ method: "POST", url: "/v1/eg/cart/lines", headers: { ...bearer(s.token), "idempotency-key": key }, payload: { sku_id: t.seed.skuA, qty } });
    const a = await add(2);
    const b = await add(2);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(json(b.body)).toEqual(json(a.body));
    expect((await add(3)).statusCode).toBe(422);
    const cart = json<{ groups: { lines: { qty: number }[] }[] }>((await t.inject({ method: "GET", url: "/v1/eg/cart", headers: bearer(s.token) })).body);
    expect(cart.groups[0]?.lines[0]?.qty).toBe(2);
  });

  it("refuses save-for-later honestly and returns no free-delivery suggestions (no engine yet)", async () => {
    const s = await t.shopper();
    const { lineId } = await addToBag(t, s.token);
    const patch = await t.inject({ method: "PATCH", url: `/v1/eg/cart/lines/${lineId}`, headers: authedHeaders(t, s.token), payload: { saved_for_later: true } });
    expect(patch.statusCode).toBe(422);
    const sug = await t.inject({ method: "GET", url: `/v1/eg/cart/free-delivery-suggestions?store_id=${t.seed.storeA}`, headers: bearer(s.token) });
    expect(json<{ items: unknown[]; next_cursor: null }>(sug.body)).toEqual({ items: [], next_cursor: null });
  });
});

describe("checkout", () => {
  it("quotes purely (no order rows), places one order group and reserves stock", async () => {
    const s = await t.shopper();
    await addToBag(t, s.token);
    const q = await quote(t, s.token);
    expect((await t.raw.query("SELECT 1 FROM order_groups WHERE user_id = $1", [s.userId])).rows).toHaveLength(0);
    const res = await t.inject(checkoutRequest(t, s.token, q));
    expect(res.statusCode).toBe(201);
    const body = json<{ order_group_id: string; status: string; client_action: { kind: string; url: string }; reservation_expires_at: string }>(res.body);
    expect(body).toMatchObject({ status: "PENDING_PAYMENT", client_action: { kind: "redirect" } });
    expect(body.reservation_expires_at).toBeTruthy();
    const g = json<{ seller_orders: { store_display_name_ar: string; lines: unknown[] }[]; total: { amount_minor: string } }>(
      (await t.inject({ method: "GET", url: `/v1/eg/order-groups/${body.order_group_id}`, headers: bearer(s.token) })).body,
    );
    expect(g.seller_orders).toHaveLength(1);
    expect(g.seller_orders[0]?.lines).toHaveLength(1);
    expect(g.total.amount_minor).toBe((q.total as { amount_minor: string }).amount_minor);
  });

  it("a tampered quote echo is refused (422) and places nothing", async () => {
    const s = await t.shopper();
    await addToBag(t, s.token);
    const q = await quote(t, s.token);
    const echo = JSON.parse(JSON.stringify(q.quote_echo)) as { total: { amountMinor: string } };
    echo.total.amountMinor = "1";
    const res = await t.inject(checkoutRequest(t, s.token, { ...q, quote_echo: echo }));
    expect(res.statusCode).toBe(422);
    expect((await t.raw.query("SELECT 1 FROM order_groups WHERE user_id = $1", [s.userId])).rows).toHaveLength(0);
  });

  it("an engaged payment kill switch answers 403 method-unavailable and places nothing", async () => {
    const s = await t.shopper();
    await addToBag(t, s.token);
    const q = await quote(t, s.token);
    t.fakes.kill.engaged.add("payments.card.enabled");
    try {
      const res = await t.inject(checkoutRequest(t, s.token, q));
      expect(res.statusCode).toBe(403);
      expect(json<{ code: string }>(res.body).code).toBe("method-unavailable");
      const quoted = await t.inject({ method: "POST", url: "/v1/eg/checkout/quote", headers: bearer(s.token), payload: { address_id: ADDRESS, payment_method: "card" } });
      expect(quoted.statusCode).toBe(403);
    } finally {
      t.fakes.kill.engaged.delete("payments.card.enabled");
    }
    expect((await t.raw.query("SELECT 1 FROM order_groups WHERE user_id = $1", [s.userId])).rows).toHaveLength(0);
  });

  it("reports unresolved voucher codes and refuses partial checkout instead of ignoring them", async () => {
    const s = await t.shopper();
    await addToBag(t, s.token);
    const v = await t.inject({ method: "POST", url: "/v1/eg/checkout/quote", headers: bearer(s.token), payload: { address_id: ADDRESS, payment_method: "card", voucher_codes: ["SAVE10"] } });
    expect(json<{ invalid_voucher_codes: string[] }>(v.body).invalid_voucher_codes).toEqual(["SAVE10"]);
    const p = await t.inject({ method: "POST", url: "/v1/eg/checkout/quote", headers: bearer(s.token), payload: { address_id: ADDRESS, payment_method: "card", cart_line_ids: [randomUUID()] } });
    expect(json<{ code: string }>(p.body).code).toBe("partial-checkout-unsupported");
  });

  it("lists my orders newest first with a keyset cursor", async () => {
    const s = await t.shopper();
    for (let i = 0; i < 3; i++) {
      await addToBag(t, s.token);
      await t.inject(checkoutRequest(t, s.token, await quote(t, s.token)));
    }
    const page1 = json<{ items: { id: string }[]; next_cursor: string }>((await t.inject({ method: "GET", url: "/v1/eg/order-groups?limit=2", headers: bearer(s.token) })).body);
    expect(page1.items).toHaveLength(2);
    const page2 = json<{ items: { id: string }[]; next_cursor: string | null }>((await t.inject({ method: "GET", url: `/v1/eg/order-groups?limit=2&cursor=${page1.next_cursor}`, headers: bearer(s.token) })).body);
    expect(page2.items).toHaveLength(1);
    expect(page2.next_cursor).toBeNull();
    expect(new Set([...page1.items, ...page2.items].map((x) => x.id)).size).toBe(3);
  });

  it("COD: a wrong code is refused, the right code confirms and claims stock", async () => {
    t.fakes.risk.decision = "require_confirmation";
    const o = await placeOrder(t, "cod");
    t.fakes.risk.decision = "allow";
    expect(o.status).toBe("AWAITING_COD_CONFIRMATION");
    const wrong = await t.inject({ method: "POST", url: `/v1/eg/order-groups/${o.groupId}/cod-confirmation`, headers: authedHeaders(t, o.token), payload: { code: "000000" } });
    expect(wrong.statusCode).toBe(422);
    const ok = await t.inject({ method: "POST", url: `/v1/eg/order-groups/${o.groupId}/cod-confirmation`, headers: authedHeaders(t, o.token), payload: { code: "123456" } });
    expect(json<{ status: string }>(ok.body).status).toBe("CONFIRMED_COD");
    const again = await t.inject({ method: "POST", url: `/v1/eg/order-groups/${o.groupId}/cod-confirmation`, headers: authedHeaders(t, o.token), payload: { code: "123456" } });
    expect(again.statusCode).toBe(409);
  });
});

describe("PSP webhook", () => {
  const status = async (token: string, id: string): Promise<string> => json<{ status: string }>((await t.inject({ method: "GET", url: `/v1/eg/order-groups/${id}`, headers: bearer(token) })).body).status;
  const ledgerEntries = async (): Promise<number> => Number((await t.raw.query<{ n: string }>("SELECT count(*)::text AS n FROM journal_entries")).rows[0]?.n ?? 0);

  it("a good signature settles the order; the same event again is a duplicate with no new effect", async () => {
    const o = await placeOrder(t, "card");
    const req = await webhookFor(t, o.groupId, "payment.succeeded", { eventId: "evt-dup-1" });
    const first = await t.inject(req);
    expect(first.statusCode).toBe(200);
    expect(json<{ received: boolean; duplicate: boolean }>(first.body)).toEqual({ received: true, duplicate: false });
    expect(await status(o.token, o.groupId)).toBe("PAID");
    const entries = await ledgerEntries();
    const second = await t.inject(req);
    expect(second.statusCode).toBe(200);
    expect(json<{ duplicate: boolean }>(second.body).duplicate).toBe(true);
    expect(await ledgerEntries()).toBe(entries);
    expect((await t.raw.query("SELECT 1 FROM payment_events_raw WHERE provider_event_id = 'evt-dup-1'")).rows).toHaveLength(1);
  });

  it("a bad signature is 401 and changes no order, ledger or stock state", async () => {
    const o = await placeOrder(t, "card");
    const entries = await ledgerEntries();
    const res = await t.inject(await webhookFor(t, o.groupId, "payment.succeeded", { badSignature: true }));
    expect(res.statusCode).toBe(401);
    expect(json<{ code: string }>(res.body).code).toBe("webhook-signature-invalid");
    expect(await status(o.token, o.groupId)).toBe("PENDING_PAYMENT");
    expect(await ledgerEntries()).toBe(entries);
  });

  it("a source address outside the allow-list is refused before any verification (403)", async () => {
    const o = await placeOrder(t, "card");
    const req = await webhookFor(t, o.groupId, "payment.succeeded");
    const res = await t.inject({ ...req, remoteAddress: "203.0.113.9" });
    expect(res.statusCode).toBe(403);
    expect(await status(o.token, o.groupId)).toBe("PENDING_PAYMENT");
  });

  it("a failed attempt is recorded without failing the order (the shopper may retry); malformed JSON is 400", async () => {
    const o = await placeOrder(t, "card");
    expect((await t.inject(await webhookFor(t, o.groupId, "payment.failed"))).statusCode).toBe(200);
    expect(await status(o.token, o.groupId)).toBe("PENDING_PAYMENT");
    expect((await t.raw.query<{ processing_status: string }>("SELECT processing_status FROM payment_events_raw WHERE event_type = 'payment.failed' ORDER BY received_at DESC LIMIT 1")).rows[0]?.processing_status).toBe("processed");
    const bad = await t.inject({ method: "POST", url: "/v1/eg/webhooks/psp/paymob", headers: { "content-type": "application/json" }, payload: "{not json" });
    expect(bad.statusCode).toBe(400);
  });

  it("caps the body at 256 KB (413)", async () => {
    const res = await t.inject({ method: "POST", url: "/v1/eg/webhooks/psp/paymob", headers: { "content-type": "application/json" }, payload: JSON.stringify({ pad: "x".repeat(300 * 1024) }) });
    expect(res.statusCode).toBe(413);
  });
});
