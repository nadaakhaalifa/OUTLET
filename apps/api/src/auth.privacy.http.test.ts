import { Controller, Delete, Get } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Authorize, AUTHENTICATOR, type Authenticator, type ResourceResolver } from "./platform";
import { DEV_ATTESTATION_PREFIX } from "./modules/auth";
import {
  ATTEST_HEADERS,
  createHarness,
  IDEM_KEY_1,
  IDEM_KEY_2,
  INSTALL_ID,
  login,
  PHONE,
  type Harness,
} from "./test/harness";

const REFUND_RESOLVER = Symbol("test.refund-resolver");

@Controller("test")
class AdminProbeController {
  /** An admin-only resource: a shopper must never pass, whatever the object. */
  @Delete("refunds/:id")
  @Authorize({ action: "approve", resourceType: "refund", resolver: REFUND_RESOLVER, idParam: "id" })
  approve() {
    return { approved: true };
  }

  @Get("seller")
  @Authorize({ action: "read", resourceType: "store_order", resolver: REFUND_RESOLVER, idParam: "id", audience: "seller_api" })
  sellerOnly() {
    return { ok: true };
  }
}

const refundResolver: ResourceResolver = {
  async resolve({ id }) {
    return { type: "refund", id: id ?? "r1", state: "active", amountMinor: 100n };
  },
};

let currentHarness: Harness | undefined;

const att = (phone: string) => {
  const keyId = `key-${phone.slice(-8)}`;
  // These tests exercise OTP, not the age gate (covered in auth.identity.http.test.ts).
  currentHarness?.grantAgeGate(keyId);
  return { "X-App-Attest": `${DEV_ATTESTATION_PREFIX}${keyId}`, "X-Client-Platform": "ios" };
};

describe("auth, sessions and privacy over HTTP", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({
      controllers: [AdminProbeController],
      providers: [{ provide: REFUND_RESOLVER, useValue: refundResolver }],
    });
    currentHarness = h;
  });
  afterAll(async () => h.close());

  describe("OTP request", () => {
    it("202 with challenge, expiry and resend time; the code reaches only the dev mailbox", async () => {
      const r = await h.http().post("/v1/auth/otp/request").set(att("+201112223334")).send({ phone_e164: "+201112223334" });
      expect(r.status).toBe(202);
      expect(r.body.challenge_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.body.attempts_remaining).toBe(5);
      expect(Date.parse(r.body.expires_at) - h.clock.nowMs()).toBe(5 * 60_000);
      expect(Date.parse(r.body.resend_available_at)).toBeGreaterThan(h.clock.nowMs());
      const code = h.mailbox.last("+201112223334")?.code;
      expect(code).toMatch(/^[0-9]{6}$/);
      expect(JSON.stringify(r.body)).not.toContain(code ?? "never");
    });

    it("rejects non-Egyptian and malformed numbers and unknown fields at validation", async () => {
      for (const body of [{ phone_e164: "+14155550100" }, { phone_e164: "01001234567" }, {}, { phone_e164: PHONE, extra: 1 }]) {
        const r = await h.http().post("/v1/auth/otp/request").set(ATTEST_HEADERS).send(body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.body.type).toBe("/problems/validation-failed");
      }
    });

    it("403 without a valid device attestation and sends nothing", async () => {
      const before = h.mailbox.entries.length;
      const none = await h.http().post("/v1/auth/otp/request").send({ phone_e164: "+201005550001" });
      expect(none.status).toBe(403);
      expect(none.body.code).toBe("attestation_failed");
      const forged = await h
        .http()
        .post("/v1/auth/otp/request")
        .set({ "X-App-Attest": "real-looking-token", "X-Client-Platform": "ios" })
        .send({ phone_e164: "+201005550001" });
      expect(forged.status).toBe(403);
      expect(h.mailbox.entries.length).toBe(before);
    });

    it("enforces the resend timer, then the per-phone window limit, with Retry-After", async () => {
      const phone = "+201005550002";
      const first = await h.http().post("/v1/auth/otp/request").set(att(phone)).send({ phone_e164: phone });
      expect(first.status).toBe(202);
      const tooSoon = await h.http().post("/v1/auth/otp/request").set(att(phone)).send({ phone_e164: phone });
      expect(tooSoon.status).toBe(429);
      expect(Number(tooSoon.headers["retry-after"])).toBeGreaterThan(0);
      h.clock.advance(31_000);
      expect((await h.http().post("/v1/auth/otp/request").set(att(phone)).send({ phone_e164: phone })).status).toBe(202);
      h.clock.advance(61_000);
      // Fourth attempt (the refused one counts) inside the 15 minute window: the edge limiter,
      // 3 per phone per window, refuses before any SMS cost is incurred.
      const fourth = await h.http().post("/v1/auth/otp/request").set(att(phone)).send({ phone_e164: phone });
      expect(fourth.status).toBe(429);
      expect(fourth.body.code).toBe("rate_limited");
    });

    it("an Idempotency-Key replay returns the same challenge and sends one SMS", async () => {
      const phone = "+201005550003";
      const before = h.mailbox.entries.length;
      const a = await h.http().post("/v1/auth/otp/request").set(att(phone)).set("Idempotency-Key", IDEM_KEY_1).send({ phone_e164: phone });
      const b = await h.http().post("/v1/auth/otp/request").set(att(phone)).set("Idempotency-Key", IDEM_KEY_1).send({ phone_e164: phone });
      expect(a.status).toBe(202);
      expect(b.status).toBe(202);
      expect(b.body).toEqual(a.body);
      expect(b.headers["idempotent-replayed"]).toBe("true");
      expect(h.mailbox.entries.length).toBe(before + 1);
      const other = await h.http().post("/v1/auth/otp/request").set(att("+201005550004")).set("Idempotency-Key", IDEM_KEY_1).send({ phone_e164: "+201005550004" });
      expect(other.status).toBe(422);
    });
  });

  describe("OTP verify", () => {
    async function challenge(phone: string): Promise<{ id: string; code: string; headers: Record<string, string> }> {
      const r = await h.http().post("/v1/auth/otp/request").set(att(phone)).send({ phone_e164: phone });
      expect(r.status).toBe(202);
      return { id: r.body.challenge_id, code: h.mailbox.last(phone)?.code ?? "", headers: att(phone) };
    }
    const device = { platform: "ios", install_id: INSTALL_ID };

    it("returns a token pair and a masked profile; the token works and is audience scoped", async () => {
      const phone = "+201005550010";
      const c = await challenge(phone);
      const r = await h.http().post("/v1/auth/otp/verify").set(c.headers).send({ challenge_id: c.id, code: c.code, device });
      expect(r.status).toBe(200);
      expect(r.body.user).toMatchObject({ phone_masked: "**********567".replace("567", phone.slice(-3)), phone_verified: true, locale: "ar-EG" });
      expect(r.body.user.phone_masked).not.toContain(phone.slice(0, 8));
      expect(Date.parse(r.body.access_expires_at) - h.clock.nowMs()).toBe(10 * 60_000);
      expect(Date.parse(r.body.refresh_expires_at) - h.clock.nowMs()).toBe(30 * 86_400_000);
      expect(r.body.refresh_token).toMatch(/^[0-9a-f]{64}$/);
      const consent = await h.http().get("/v1/me/privacy/consents").set("Authorization", `Bearer ${r.body.access_token}`);
      expect(consent.status).toBe(200);
    });

    it("a code works once: replay is invalid, never a second session", async () => {
      const c = await challenge("+201005550011");
      const ok = await h.http().post("/v1/auth/otp/verify").set(c.headers).send({ challenge_id: c.id, code: c.code, device });
      expect(ok.status).toBe(200);
      const again = await h.http().post("/v1/auth/otp/verify").set(c.headers).send({ challenge_id: c.id, code: c.code, device });
      expect(again.status).toBe(422);
      expect(again.body.code).toBe("otp_invalid");
    });

    it("concurrent verifications of one correct code yield exactly one session", async () => {
      const c = await challenge("+201005550012");
      const rs = await Promise.all(
        Array.from({ length: 4 }, () =>
          h.http().post("/v1/auth/otp/verify").set(c.headers).send({ challenge_id: c.id, code: c.code, device }),
        ),
      );
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    });

    it("wrong code reports remaining attempts; five wrong codes lock the challenge even for the right one", async () => {
      const c = await challenge("+201005550013");
      const wrong = c.code === "000000" ? "111111" : "000000";
      const first = await h.http().post("/v1/auth/otp/verify").set(c.headers).send({ challenge_id: c.id, code: wrong, device });
      expect(first.status).toBe(422);
      expect(first.body.attempts_remaining).toBe(4);
      h.clock.advance(1);
      for (let i = 0; i < 4; i++) {
        await h.http().post("/v1/auth/otp/verify").set(c.headers).send({ challenge_id: c.id, code: wrong, device });
        h.clock.advance(1);
      }
      const locked = await h.http().post("/v1/auth/otp/verify").set(c.headers).send({ challenge_id: c.id, code: c.code, device });
      expect([422, 429]).toContain(locked.status);
      expect(locked.status).not.toBe(200);
    });

    it("expired codes are refused", async () => {
      const c = await challenge("+201005550014");
      h.clock.advance(5 * 60_000 + 1);
      const r = await h.http().post("/v1/auth/otp/verify").set(c.headers).send({ challenge_id: c.id, code: c.code, device });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe("otp_expired");
    });

    it("unknown challenge and a different attested device are indistinguishable from a wrong code", async () => {
      const unknown = await h
        .http()
        .post("/v1/auth/otp/verify")
        .set(ATTEST_HEADERS)
        .send({ challenge_id: "0192f3a4-5b6c-4d8e-9f01-23456789abff", code: "123456", device });
      expect(unknown.status).toBe(422);
      expect(unknown.body.code).toBe("otp_invalid");
      const c = await challenge("+201005550015");
      const otherDevice = await h
        .http()
        .post("/v1/auth/otp/verify")
        .set({ "X-App-Attest": "dev-fixture-attest:key-other-device", "X-Client-Platform": "ios" })
        .send({ challenge_id: c.id, code: c.code, device });
      expect(otherDevice.status).toBe(422);
      expect(otherDevice.body.code).toBe("otp_invalid");
    });

    it("rejects malformed bodies", async () => {
      for (const body of [{}, { challenge_id: "x", code: "123456", device }, { challenge_id: "0192f3a4-5b6c-4d8e-9f01-23456789abff", code: "12345", device }]) {
        const r = await h.http().post("/v1/auth/otp/verify").set(ATTEST_HEADERS).send(body);
        expect(r.status).toBe(400);
      }
    });
  });

  describe("negative authorization", () => {
    it("sessions: 401 without a token", async () => {
      const r = await h.http().get("/v1/me/sessions/0192f3a4-5b6c-4d8e-9f01-23456789abff");
      expect(r.status).toBe(401);
    });

    it("a shopper reads their own session and it is flagged current", async () => {
      const a = await login(h, "+201005550020");
      const r = await h.http().get(`/v1/me/sessions/${a.sessionId}`).set("Authorization", `Bearer ${a.accessToken}`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ id: a.sessionId, platform: "ios", current: true });
    });

    it("another shopper gets 404, identical to a session that does not exist (no object enumeration)", async () => {
      const a = await login(h, "+201005550021", { "X-App-Attest": "dev-fixture-attest:key-a-1234", "X-Client-Platform": "ios" });
      const b = await login(h, "+201005550022", { "X-App-Attest": "dev-fixture-attest:key-b-1234", "X-Client-Platform": "ios" });
      const notMine = await h.http().get(`/v1/me/sessions/${a.sessionId}`).set("Authorization", `Bearer ${b.accessToken}`);
      const missing = await h.http().get("/v1/me/sessions/0192f3a4-5b6c-7d8e-9f01-23456789abff").set("Authorization", `Bearer ${b.accessToken}`);
      expect(notMine.status).toBe(404);
      expect(missing.status).toBe(404);
      expect({ ...notMine.body, request_id: undefined }).toEqual({ ...missing.body, request_id: undefined });
      const del = await h.http().delete(`/v1/me/sessions/${a.sessionId}`).set("Authorization", `Bearer ${b.accessToken}`);
      expect(del.status).toBe(404);
      // A's session is untouched.
      expect((await h.http().get(`/v1/me/sessions/${a.sessionId}`).set("Authorization", `Bearer ${a.accessToken}`)).status).toBe(200);
      const denied = h.audit.entries.filter((e) => e.effect === "deny" && e.actorId !== null);
      expect(denied.some((e) => e.reason === "not_owned" || e.reason === "resource_not_found")).toBe(true);
    });

    it("revoking a session kills its token immediately and a second revoke is 404", async () => {
      const a = await login(h, "+201005550023");
      const auth = { Authorization: `Bearer ${a.accessToken}` };
      expect((await h.http().delete(`/v1/me/sessions/${a.sessionId}`).set(auth)).status).toBe(204);
      expect((await h.http().get("/v1/me/privacy/consents").set(auth)).status).toBe(401);
      expect((await h.http().delete(`/v1/me/sessions/${a.sessionId}`).set(auth)).status).toBe(401);
    });

    it("an expired access token is refused", async () => {
      const a = await login(h, "+201005550024");
      h.clock.advance(10 * 60_000 + 1000);
      const r = await h.http().get("/v1/me/privacy/consents").set("Authorization", `Bearer ${a.accessToken}`);
      expect(r.status).toBe(401);
    });

    it("a shopper cannot reach admin-only resources, and the denial is audited", async () => {
      const a = await login(h, "+201005550025");
      const before = h.audit.entries.length;
      const r = await h.http().delete("/v1/test/refunds/r-1").set("Authorization", `Bearer ${a.accessToken}`);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ type: "/problems/forbidden", status: 403 });
      const entry = h.audit.entries[before];
      expect(entry).toMatchObject({ effect: "deny", actorId: a.userId, resourceType: "refund", httpStatus: 403 });
      expect(entry?.reason).not.toBe("allowed");
    });

    it("a buyer token is refused on a seller-audience route", async () => {
      const a = await login(h, "+201005550026");
      const r = await h.http().get("/v1/test/seller").set("Authorization", `Bearer ${a.accessToken}`);
      expect(r.status).toBe(401);
    });

    it("a token whose subject is suspended is refused", async () => {
      const a = await login(h, "+201005550027");
      const auth = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false });
      const original = auth.authenticate.bind(auth);
      auth.authenticate = async (t, n) => {
        const p = await original(t, n);
        return p === null ? null : { ...p, actor: { ...p.actor, status: "suspended" } };
      };
      try {
        const r = await h.http().get("/v1/me/privacy/consents").set("Authorization", `Bearer ${a.accessToken}`);
        expect(r.status).toBe(403);
        expect(r.body.code).toBe("account_not_active");
      } finally {
        auth.authenticate = original;
      }
    });
  });

  describe("consent read and update", () => {
    let token = "";
    let otherToken = "";
    beforeAll(async () => {
      token = (await login(h, "+201005550030", { "X-App-Attest": "dev-fixture-attest:key-c-1234", "X-Client-Platform": "ios" })).accessToken;
      otherToken = (await login(h, "+201005550031", { "X-App-Attest": "dev-fixture-attest:key-d-1234", "X-Client-Platform": "ios" })).accessToken;
    });
    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

    it("starts with nothing granted and nothing pre-ticked", async () => {
      const r = await h.http().get("/v1/me/privacy/consents").set(bearer(token));
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ consents: [] });
      expect(r.headers["etag"]).toMatch(/^"[0-9a-f]{32}"$/);
    });

    it("401 without a token", async () => {
      expect((await h.http().get("/v1/me/privacy/consents")).status).toBe(401);
      expect((await h.http().patch("/v1/me/privacy/consents").send({ changes: [] })).status).toBe(401);
    });

    it("grants, reads back, and supports conditional GET", async () => {
      const patch = await h
        .http()
        .patch("/v1/me/privacy/consents")
        .set(bearer(token))
        .send({ changes: [{ purpose: "analytics", granted: true, policy_version: "1" }] });
      expect(patch.status).toBe(200);
      expect(patch.body.consents).toEqual([
        { purpose: "analytics", granted: true, updated_at: new Date(h.clock.nowMs()).toISOString(), policy_version: "1" },
      ]);
      const get = await h.http().get("/v1/me/privacy/consents").set(bearer(token));
      expect(get.body).toEqual(patch.body);
      const etag = get.headers["etag"] as string;
      const cond = await h.http().get("/v1/me/privacy/consents").set(bearer(token)).set("If-None-Match", etag);
      expect(cond.status).toBe(304);
      expect(cond.text).toBe("");
    });

    it("withdrawal is recorded and wins; consent is per user", async () => {
      h.clock.advance(1000);
      const w = await h
        .http()
        .patch("/v1/me/privacy/consents")
        .set(bearer(token))
        .send({ changes: [{ purpose: "analytics", granted: false, policy_version: "1" }] });
      expect(w.status).toBe(200);
      expect(w.body.consents[0]).toMatchObject({ purpose: "analytics", granted: false });
      const other = await h.http().get("/v1/me/privacy/consents").set(bearer(otherToken));
      expect(other.body).toEqual({ consents: [] });
    });

    it("rejects unknown purposes (including marketing_sms, which B1 does not define) and bad shapes", async () => {
      for (const changes of [
        [{ purpose: "marketing_sms", granted: true, policy_version: "1" }],
        [{ purpose: "analytics", granted: "yes", policy_version: "1" }],
        [{ purpose: "analytics", granted: true, policy_version: 1 }],
        [{ purpose: "analytics", granted: true, policy_version: "v1" }],
        [{ purpose: "analytics", granted: true }],
        [],
      ]) {
        const r = await h.http().patch("/v1/me/privacy/consents").set(bearer(token)).send({ changes });
        expect(r.status, JSON.stringify(changes)).toBe(400);
      }
      expect((await h.http().patch("/v1/me/privacy/consents").set(bearer(token)).send({ changes: [], x: 1 })).status).toBe(400);
    });

    it("refuses a grant on a stale text version and a duplicated purpose, applying nothing", async () => {
      const bumped = await createHarness({ env: { CONSENT_TEXT_VERSION: "3" } });
      try {
        const u = await login(bumped, "+201005550040");
        const stale = await bumped
          .http()
          .patch("/v1/me/privacy/consents")
          .set(bearer(u.accessToken))
          .send({
            changes: [
              { purpose: "personalization", granted: true, policy_version: "3" },
              { purpose: "analytics", granted: true, policy_version: "2" },
            ],
          });
        expect(stale.status).toBe(422);
        expect(stale.body).toMatchObject({ code: "consent_version_stale", purpose: "analytics", current_policy_version: "3" });
        const dup = await bumped
          .http()
          .patch("/v1/me/privacy/consents")
          .set(bearer(u.accessToken))
          .send({
            changes: [
              { purpose: "analytics", granted: true, policy_version: "3" },
              { purpose: "analytics", granted: false, policy_version: "3" },
            ],
          });
        expect(dup.status).toBe(422);
        expect(dup.body.code).toBe("duplicate_purpose");
        const after = await bumped.http().get("/v1/me/privacy/consents").set(bearer(u.accessToken));
        expect(after.body).toEqual({ consents: [] });
        // Withdrawal is accepted even on an old version.
        const w = await bumped
          .http()
          .patch("/v1/me/privacy/consents")
          .set(bearer(u.accessToken))
          .send({ changes: [{ purpose: "analytics", granted: false, policy_version: "1" }] });
        expect(w.status).toBe(200);
      } finally {
        await bumped.close();
      }
    });

    it("an Idempotency-Key replay on PATCH does not append a second record", async () => {
      const body = { changes: [{ purpose: "marketing_push", granted: true, policy_version: "1" }] };
      const a = await h.http().patch("/v1/me/privacy/consents").set(bearer(token)).set("Idempotency-Key", IDEM_KEY_2).send(body);
      h.clock.advance(5000);
      const b = await h.http().patch("/v1/me/privacy/consents").set(bearer(token)).set("Idempotency-Key", IDEM_KEY_2).send(body);
      expect(b.headers["idempotent-replayed"]).toBe("true");
      expect(b.body).toEqual(a.body);
    });

    it("idempotency keys are scoped per actor: another user's identical key does not replay", async () => {
      const body = { changes: [{ purpose: "marketing_email", granted: true, policy_version: "1" }] };
      const key = "0192f3a4-5b6c-7d8e-9f01-23456789abc9";
      const mine = await h.http().patch("/v1/me/privacy/consents").set(bearer(token)).set("Idempotency-Key", key).send(body);
      const theirs = await h.http().patch("/v1/me/privacy/consents").set(bearer(otherToken)).set("Idempotency-Key", key).send(body);
      expect(mine.status).toBe(200);
      expect(theirs.status).toBe(200);
      expect(theirs.headers["idempotent-replayed"]).toBeUndefined();
      expect(theirs.body.consents).toHaveLength(1);
      const mineAgain = await h.http().get("/v1/me/privacy/consents").set(bearer(token));
      expect(mineAgain.body.consents.some((c: { purpose: string }) => c.purpose === "marketing_email")).toBe(true);
    });
  });
});
