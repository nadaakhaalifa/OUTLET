/**
 * Negative authorization for POST /v1/me/guest-merge: unauthenticated 401, malformed token 401, wrong audience
 * (seller_api, admin_api) 401, suspended subject 403. The 18+ rule is the same as for cart writes: a token exists
 * only after the age gate, so there is no under-age token to present; a non-active subject is the 403 path.
 * The route has no object id in it (self), so BOLA is covered by "the caller's own cart only" in the HTTP suite.
 */
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { buildAccessClaims } from "@outlet/auth-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTHZ_META, type AuthzMeta, IDEMPOTENT_META, RATE_LIMIT_META } from "../../../platform/decorators";
import { AUTHENTICATOR, type Authenticator } from "../../../platform";
import { createHarness, login, type Harness, type LoggedIn } from "../../../test/harness";
import { GuestMergeController } from "../adapters/guest-merge.controller";
import { GUEST_BROWSING_GATE } from "../../../platform/tokens";

let h: Harness;
let a: LoggedIn;
const send = (t: string | null) => {
  const r = h.http().post("/v1/me/guest-merge").set({ "Idempotency-Key": "0192f3a4-5b6c-7d8e-9f01-0000000000aa" });
  return (t === null ? r : r.set({ Authorization: `Bearer ${t}` })).send({});
};

beforeAll(async () => {
  h = await createHarness({ customise: (b) => b.overrideProvider(GUEST_BROWSING_GATE).useValue({ enabled: async () => true }) });
  a = await login(h, "+201007799001");
}, 60_000);
afterAll(async () => {
  await h.close();
});

describe("route declaration (A3)", () => {
  const fn = (GuestMergeController.prototype as unknown as Record<string, object>)["run"] as object;
  it("is POST /v1/me/guest-merge, self/buyer_api, idempotency required, per-user rate limited", () => {
    expect(Reflect.getMetadata(METHOD_METADATA, fn)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, fn)).toBe("guest-merge");
    expect(Reflect.getMetadata(AUTHZ_META, fn) as AuthzMeta).toEqual({ kind: "self", audience: "buyer_api" });
    expect(Reflect.getMetadata(IDEMPOTENT_META, fn)).toEqual({ required: true });
    const rl = Reflect.getMetadata(RATE_LIMIT_META, fn) as { rules: { dimension: string; limit: number; windowSeconds: number }[] };
    expect(rl.rules).toEqual([
      { dimension: "user", limit: 5, windowSeconds: 60 },
      { dimension: "session", limit: 20, windowSeconds: 86_400 },
    ]);
  });
});

describe("POST /v1/me/guest-merge: negative authorization", () => {
  it("unauthenticated is 401 with no extra problem members", async () => {
    const r = await send(null);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("unauthenticated");
    expect(Object.keys(r.body).sort()).toEqual(["code", "request_id", "status", "title", "type"]);
  });

  it("a malformed bearer token is 401", async () => {
    expect((await send("not-a-real-token-0000000000")).status).toBe(401);
  });

  it.each(["seller_api", "admin_api"] as const)("a %s token is 401", async (audience) => {
    const authn = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false });
    const issuer = authn as unknown as { issue(claims: unknown): Promise<string> };
    const token = await issuer.issue(
      buildAccessClaims({
        issuer: h.config.tokenIssuer,
        userId: a.userId,
        audience,
        sessionId: a.sessionId,
        jti: `jti-guest-merge-${audience}`,
        amr: ["otp_sms"],
        nowMs: h.clock.nowMs(),
      }),
    );
    expect((await send(token)).status).toBe(401);
  });

  it("a suspended subject is 403 account_not_active and nothing is merged", async () => {
    const authn = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false });
    const original = authn.authenticate.bind(authn);
    authn.authenticate = async (t, n) => {
      const p = await original(t, n);
      return p === null ? null : { ...p, actor: { ...p.actor, status: "suspended" } };
    };
    try {
      const r = await send(a.accessToken);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("account_not_active");
    } finally {
      authn.authenticate = original;
    }
  });

  it("the rate limit is 5 per minute per user: the sixth call in a minute is 429", async () => {
    const u = await login(h, "+201007799002");
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await h
        .http()
        .post("/v1/me/guest-merge")
        .set({ Authorization: `Bearer ${u.accessToken}`, "Idempotency-Key": `0192f3a4-5b6c-7d8e-9f01-00000000b0${String(i).padStart(2, "0")}` })
        .send({});
      codes.push(r.status);
    }
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
  });

  it("the daily limit is 20 per session: the 21st call in a day is 429 even with the per-minute window clear", async () => {
    const u = await login(h, "+201007799003");
    const codes: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      // Five calls fit a minute; stay inside the 10-minute access token.
      if (i % 5 === 0) h.clock.advance(61_000);
      const r = await h
        .http()
        .post("/v1/me/guest-merge")
        .set({ Authorization: `Bearer ${u.accessToken}`, "Idempotency-Key": `0192f3a4-5b6c-7d8e-9f01-00000000c${String(i).padStart(3, "0")}` })
        .send({});
      codes.push(r.status);
    }
    expect(codes.slice(0, 20)).toEqual(Array(20).fill(200));
    expect(codes[20]).toBe(429);
  });
});
