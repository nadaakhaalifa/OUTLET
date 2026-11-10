import { randomInt, randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import type { InjectOptions } from "fastify";
import { RP_ID, RP_ORIGIN, bearer, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";
import { VirtualAuthenticator } from "./webauthn.js";

export const phone = (): string => `+2010${String(randomInt(10_000_000, 99_999_999))}`;

export interface SignedIn {
  readonly userId: string;
  readonly sessionId: string;
  readonly token: string;
  readonly refresh: string;
  readonly deviceId: string;
  readonly phone: string;
}

/** Real OTP sign-in over HTTP (new account, born 1990). */
export const signIn = async (t: TestApp): Promise<SignedIn> => {
  const deviceId = await t.device();
  const p = phone();
  const h = { "x-device-id": deviceId };
  const req = await t.inject({ method: "POST", url: "/v1/eg/auth/otp/request", headers: { ...h, "idempotency-key": idemKey(t) }, payload: { phone_e164: p, channel: "sms", purpose: "sign_in" } });
  if (req.statusCode !== 201) throw new Error(`otp request failed: ${req.body}`);
  const { challenge_id } = JSON.parse(req.body) as { challenge_id: string };
  const ver = await t.inject({ method: "POST", url: "/v1/eg/auth/otp/verify", headers: { ...h, "idempotency-key": idemKey(t) }, payload: { challenge_id, phone_e164: p, code: t.sms.last(), dob: "1990-01-01" } });
  if (ver.statusCode !== 200) throw new Error(`otp verify failed: ${ver.body}`);
  const b = JSON.parse(ver.body) as { access_token: string; refresh_token: string; user_id: string };
  const claims = decodeJwt(b.access_token);
  return { userId: b.user_id, sessionId: String(claims.sid), token: b.access_token, refresh: b.refresh_token, deviceId, phone: p };
};

export const authedHeaders = (t: TestApp, token: string, extra: Record<string, string> = {}): Record<string, string> => ({ ...bearer(token), "idempotency-key": idemKey(t), ...extra });

export const addToBag = async (t: TestApp, token: string, qty = 1): Promise<{ lineId: string }> => {
  const r = await t.inject({ method: "POST", url: "/v1/eg/cart/lines", headers: authedHeaders(t, token), payload: { sku_id: t.seed.skuA, qty } });
  if (r.statusCode !== 201) throw new Error(`add to bag failed: ${r.body}`);
  const cart = JSON.parse(r.body) as { groups: { lines: { id: string }[] }[] };
  return { lineId: cart.groups[0]?.lines[0]?.id ?? "" };
};

export const ADDRESS = "00000000-0000-4000-8000-0000000add01";

export const quote = async (t: TestApp, token: string, method = "card"): Promise<Record<string, unknown>> => {
  const r = await t.inject({ method: "POST", url: "/v1/eg/checkout/quote", headers: authedHeaders(t, token), payload: { address_id: ADDRESS, payment_method: method } });
  if (r.statusCode !== 200) throw new Error(`quote failed: ${r.body}`);
  return JSON.parse(r.body) as Record<string, unknown>;
};

export const checkoutRequest = (t: TestApp, token: string, q: Record<string, unknown>, method = "card", deviceId: string = randomUUID()): InjectOptions => ({
  method: "POST",
  url: "/v1/eg/checkout",
  headers: authedHeaders(t, token, { "x-device-id": deviceId }),
  payload: { quote_token: q.quote_token, quote_echo: q.quote_echo, address_id: ADDRESS, payment_method: method, client_total: q.total },
});

/** A shopper with one unit in the bag and a placed order. */
export const placeOrder = async (t: TestApp, method = "card"): Promise<{ userId: string; token: string; groupId: string; status: string }> => {
  const s = await t.shopper();
  await addToBag(t, s.token);
  const q = await quote(t, s.token, method);
  const r = await t.inject(checkoutRequest(t, s.token, q, method));
  if (r.statusCode !== 201) throw new Error(`checkout failed: ${r.body}`);
  const b = JSON.parse(r.body) as { order_group_id: string; status: string };
  return { ...s, groupId: b.order_group_id, status: b.status };
};

/** Registers a passkey for a signed-in user through the real routes. */
export const enrollPasskey = async (t: TestApp, s: SignedIn): Promise<VirtualAuthenticator> => {
  const authn = new VirtualAuthenticator(RP_ID, RP_ORIGIN);
  const o = await t.inject({ method: "POST", url: "/v1/eg/auth/passkeys/register/options", headers: authedHeaders(t, s.token, { "x-device-id": s.deviceId }), payload: { purpose: "register" } });
  if (o.statusCode !== 200) throw new Error(`register options failed: ${o.body}`);
  const body = JSON.parse(o.body) as { challenge_id: string; public_key: { challenge: string } };
  const v = await t.inject({
    method: "POST",
    url: "/v1/eg/auth/passkeys/register/verify",
    headers: authedHeaders(t, s.token, { "x-device-id": s.deviceId }),
    payload: { challenge_id: body.challenge_id, credential: authn.create(body.public_key.challenge) },
  });
  if (v.statusCode !== 201) throw new Error(`register verify failed: ${v.body}`);
  return authn;
};

/** Asks for assertion options and returns the signed verify request (counter and origin overridable to model attacks). */
export const assertVerifyRequest = async (t: TestApp, authn: VirtualAuthenticator, deviceId: string, o: { origin?: string; counter?: number } = {}): Promise<InjectOptions> => {
  const opts = await t.inject({ method: "POST", url: "/v1/eg/auth/passkeys/assert/options", headers: { "x-device-id": deviceId, "idempotency-key": idemKey(t) }, payload: { purpose: "sign_in" } });
  if (opts.statusCode !== 200) throw new Error(`assert options failed: ${opts.body}`);
  const body = JSON.parse(opts.body) as { challenge_id: string; public_key: { challenge: string } };
  return {
    method: "POST",
    url: "/v1/eg/auth/passkeys/assert/verify",
    headers: { "x-device-id": deviceId, "idempotency-key": idemKey(t) },
    payload: { challenge_id: body.challenge_id, credential: authn.get(body.public_key.challenge, o) },
  };
};
