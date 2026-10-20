import { buildAccessClaims } from "@outlet/auth-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AUTHENTICATOR, type Authenticator } from "../../platform";
import { createHarness, login, type Harness } from "../../test/harness";
import { InMemoryAppAttest, InMemoryReferralIdentity, InMemoryReferralStore } from "./adapters/in-memory";
import { ReferralsController } from "./adapters/referrals.controller";
import { ATTRIBUTE_REFERRAL, GET_MY_REFERRAL } from "./adapters/tokens";
import { AttributeReferral, GetMyReferral } from "./application/referrals";
import { DEFAULT_REFERRAL_CONFIG } from "./domain/rules";

let h: Harness;
let store: InMemoryReferralStore;
let identity: InMemoryReferralIdentity;
let a: { token: string; userId: string; sessionId: string };
let b: { token: string; userId: string; sessionId: string };
let c: { token: string; userId: string; sessionId: string };
let keySeq = 0;

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const key = () => `0192f3a4-5b6c-7d8e-9f01-${String(++keySeq).padStart(12, "0")}`;
const attribute = (token: string | null, body: unknown, extra: Record<string, string> = { "X-App-Attest": "ok:device" }) => {
  const r = h.http().post("/v1/referrals/attribute").set({ "Idempotency-Key": key(), ...extra });
  return (token === null ? r : r.set(bearer(token))).send(body as object);
};
const mine = (token: string | null) => {
  const r = h.http().get("/v1/me/referral");
  return token === null ? r : r.set(bearer(token));
};

class Counter {
  private n = 0;
  uuidV7(): string {
    this.n += 1;
    return `00000000-0000-7000-8000-${String(this.n).padStart(12, "0")}`;
  }
}
const entropy = {
  n: 0,
  randomBytes(length: number): Uint8Array {
    this.n += 1;
    return Uint8Array.from({ length }, (_, i) => (this.n * 11 + i * 5 + 1) & 255);
  },
};

beforeAll(async () => {
  store = new InMemoryReferralStore();
  identity = new InMemoryReferralIdentity();
  const clockRef: { h: Harness | null } = { h: null };
  const clock = { nowMs: () => clockRef.h?.clock.nowMs() ?? 1_800_000_000_000 };
  const opts = { config: DEFAULT_REFERRAL_CONFIG, requireAttest: true, deepLinkBase: "https://x.test/r" };
  h = await createHarness({
    controllers: [ReferralsController],
    providers: [
      { provide: GET_MY_REFERRAL, useValue: new GetMyReferral(store, clock, new Counter(), entropy, opts) },
      {
        provide: ATTRIBUTE_REFERRAL,
        useValue: new AttributeReferral(store, identity, new InMemoryAppAttest(), clock, new Counter(), opts),
      },
    ],
  });
  clockRef.h = h;
  const s1 = await login(h, "+201001240001");
  const s2 = await login(h, "+201001240002");
  const s3 = await login(h, "+201001240003");
  a = { token: s1.accessToken, userId: s1.userId, sessionId: s1.sessionId };
  b = { token: s2.accessToken, userId: s2.userId, sessionId: s2.sessionId };
  c = { token: s3.accessToken, userId: s3.userId, sessionId: s3.sessionId };
  identity.seed(a.userId, { deviceHashes: ["a".repeat(64)], deliveredOrderCount: 1 });
  identity.seed(b.userId, { deviceHashes: ["b".repeat(64)] });
  identity.seed(c.userId, { deviceHashes: ["c".repeat(64)] });
}, 60_000);

afterAll(async () => {
  await h.close();
});

/** Access tokens are short lived and tests move the clock: mint a fresh one per call. */
async function mint(user: { userId: string; sessionId: string }, audience: "buyer_api" | "seller_api" = "buyer_api"): Promise<string> {
  const authn = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false }) as unknown as {
    issue(x: unknown): Promise<string>;
  };
  return authn.issue(
    buildAccessClaims({
      issuer: h.config.tokenIssuer,
      userId: user.userId,
      audience,
      sessionId: user.sessionId,
      jti: `jti-ref-${Math.random().toString(36).slice(2)}`,
      amr: ["otp_sms"],
      nowMs: h.clock.nowMs(),
    }),
  );
}

afterEach(() => {
  h.clock.advance(61_000); // fresh rate-limit windows
});

describe("GET /v1/me/referral", () => {
  it("returns the caller's own code, stable across calls", async () => {
    const r1 = await mine(await mint(a));
    expect(r1.status).toBe(200);
    expect(r1.body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(r1.body.share_url).toBe(`https://x.test/r/${r1.body.code}`);
    expect(r1.body).toMatchObject({ pending_count: 0, rewarded_count: 0, rewarded_this_year: 0, yearly_cap: 50, own_offer: null, referrals: [] });
    expect(r1.body.milestone).toEqual({ every: 10, progress: 0, plus_months: 1 });
    expect((await mine(await mint(a))).body.code).toBe(r1.body.code);
  });

  it("never shows another user's code or counters (no object id exists to enumerate)", async () => {
    const ra = await mine(await mint(a));
    const rb = await mine(await mint(b));
    expect(rb.body.code).not.toBe(ra.body.code);
    expect(JSON.stringify(rb.body)).not.toContain(a.userId);
  });

  it("401 without or with a bad token", async () => {
    expect((await mine(null)).status).toBe(401);
    expect((await mine("not-a-token")).status).toBe(401);
  });
});

describe("POST /v1/referrals/attribute", () => {
  it("attributes a friend and then exposes the offer to them only", async () => {
    const code = (await mine(await mint(a))).body.code as string;
    const r = await attribute(await mint(b), { code });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ attributed: true });
    const view = await mine(await mint(b));
    expect(view.body.own_offer).toEqual({
      discount: { amount: "15000", currency: "EGP" },
      min_order: { amount: "60000", currency: "EGP" },
    });
    const owner = await mine(await mint(a));
    expect(owner.body.pending_count).toBe(1);
    expect(owner.body.own_offer).toBeNull();
  });

  it("self referral looks identical to success, earns no offer and is logged", async () => {
    const code = (await mine(await mint(c))).body.code as string;
    const r = await attribute(await mint(c), { code });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ attributed: true });
    expect((await mine(await mint(c))).body.own_offer).toBeNull();
    expect(store.events).toContainEqual(
      expect.objectContaining({ type: "referral.attribution_rejected", reason: "self_referral", refereeId: c.userId }),
    );
  });

  it("401 unauthenticated, 401 for a seller_api token", async () => {
    expect((await attribute(null, { code: "ABCDEFGH" })).status).toBe(401);
    const authn = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false }) as unknown as {
      issue(x: unknown): Promise<string>;
    };
    const token = await authn.issue(
      buildAccessClaims({
        issuer: h.config.tokenIssuer,
        userId: a.userId,
        audience: "seller_api",
        sessionId: a.sessionId,
        jti: "jti-ref-seller",
        amr: ["otp_sms"],
        nowMs: h.clock.nowMs(),
      }),
    );
    expect((await attribute(token, { code: "ABCDEFGH" })).status).toBe(401);
    expect((await mine(token)).status).toBe(401);
  });

  it("403 for a suspended subject", async () => {
    const authn = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false });
    const original = authn.authenticate.bind(authn);
    authn.authenticate = async (t, n) => {
      const p = await original(t, n);
      return p === null ? null : { ...p, actor: { ...p.actor, status: "suspended" } };
    };
    try {
      expect((await attribute(await mint(a), { code: "ABCDEFGH" })).status).toBe(403);
      expect((await mine(await mint(a))).status).toBe(403);
    } finally {
      authn.authenticate = original;
    }
  });

  it("requires an Idempotency-Key (400)", async () => {
    const r = await h.http().post("/v1/referrals/attribute").set(bearer(await mint(b))).set({ "X-App-Attest": "ok:d" }).send({ code: "ABCDEFGH" });
    expect(r.status).toBe(400);
  });

  it("replaying the same key returns the stored response", async () => {
    const k = key();
    const send = async () =>
      h.http().post("/v1/referrals/attribute").set(bearer(await mint(b))).set({ "Idempotency-Key": k, "X-App-Attest": "ok:d" }).send({ code: "ZZZZZZZZ" });
    const first = await send();
    const second = await send();
    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
  });

  it("403 without a valid App Attest assertion", async () => {
    const code = (await mine(await mint(a))).body.code as string;
    expect((await attribute(await mint(c), { code }, {})).status).toBe(403);
    expect((await attribute(await mint(c), { code }, { "X-App-Attest": "garbage" })).status).toBe(403);
  });

  it("404 for an unknown code, 400 for an invalid body", async () => {
    expect((await attribute(await mint(c), { code: "ZZZZZZZZ" })).status).toBe(404);
    expect((await attribute(await mint(c), {})).status).toBe(400);
    expect((await attribute(await mint(c), { code: "ABCDEFGH", referrer_id: a.userId })).status).toBe(400);
  });

  it("is rate limited per user (429 after 10 in a minute)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await attribute(await mint(c), { code: "ZZZZZZZZ" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
