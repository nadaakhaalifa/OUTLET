import { buildAccessClaims } from "@outlet/auth-core";
import type { Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTHENTICATOR, type Authenticator } from "../../platform";
import { login, type Harness } from "../../test/harness";
import type { FakeProvider, InMemoryConsentPort, InMemoryContactPort } from "./adapters/in-memory";
import {
  NOTIFICATION_CONSENT,
  NOTIFICATION_CONTACTS,
  NOTIFICATION_INBOX_REPO,
  NOTIFICATION_PROVIDERS,
  NOTIFICATION_PUSH_TOKENS,
  SEND_NOTIFICATION,
} from "./adapters/tokens";
import type { InMemoryInboxRepository, InMemoryPushTokenRepository, StaticProviderRegistry } from "./adapters/in-memory";
import type { SendNotification } from "./application/send-notification";
import { createNotificationsHarness } from "./test/harness";

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const MISSING = "0192f3a4-5b6c-7d8e-9f01-0000000000ff";
const INSTALL = "0192f3a4-5b6c-4d8e-9f01-23456789abcd";

let h: Harness;
let a: { token: string; userId: string; sessionId: string };
let b: { token: string; userId: string; sessionId: string };
let sender: SendNotification;
let consent: InMemoryConsentPort;
let inboxRepo: InMemoryInboxRepository;
let tokens: InMemoryPushTokenRepository;
let push: FakeProvider<"push">;

beforeAll(async () => {
  h = await createNotificationsHarness();
  const s1 = await login(h, "+201001230011");
  const s2 = await login(h, "+201001230012");
  a = { token: s1.accessToken, userId: s1.userId, sessionId: s1.sessionId };
  b = { token: s2.accessToken, userId: s2.userId, sessionId: s2.sessionId };
  sender = h.app.get<SendNotification>(SEND_NOTIFICATION, { strict: false });
  consent = h.app.get<InMemoryConsentPort>(NOTIFICATION_CONSENT, { strict: false });
  inboxRepo = h.app.get<InMemoryInboxRepository>(NOTIFICATION_INBOX_REPO, { strict: false });
  tokens = h.app.get<InMemoryPushTokenRepository>(NOTIFICATION_PUSH_TOKENS, { strict: false });
  const contacts = h.app.get<InMemoryContactPort>(NOTIFICATION_CONTACTS, { strict: false });
  contacts.set(a.userId, { locale: "ar", phone: "+201001230011", email: null });
  contacts.set(b.userId, { locale: "en", phone: "+201001230012", email: null });
  push = h.app.get<StaticProviderRegistry>(NOTIFICATION_PROVIDERS, { strict: false }).providersFor("push")[0] as FakeProvider<"push">;
}, 60_000);
afterAll(async () => {
  await h.close();
});

/** Mints a fresh token (the shared clock may have moved) for a user. */
async function mint(user: { userId: string; sessionId: string }, tag: string, audience: "buyer_api" | "seller_api" = "buyer_api"): Promise<string> {
  const authn = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false }) as unknown as { issue(c: unknown): Promise<string> };
  return authn.issue(
    buildAccessClaims({
      issuer: h.config.tokenIssuer,
      userId: user.userId,
      audience,
      sessionId: user.sessionId,
      jti: `jti-n-${tag}-${Math.random().toString(36).slice(2)}`,
      amr: ["otp_sms"],
      nowMs: h.clock.nowMs(),
    }),
  );
}

async function makeInboxItem(user: { userId: string }, ref: string): Promise<string> {
  const before = new Set(inboxRepo.all().map((m) => m.id));
  const res = await sender.execute({ userId: user.userId, templateKey: "refund_completed", ref, payload: {} });
  if (res.kind !== "accepted") throw new Error(`send failed: ${JSON.stringify(res)}`);
  const created = inboxRepo.all().find((m) => !before.has(m.id));
  if (created === undefined) throw new Error("no inbox item created");
  return created.id;
}

interface RouteCase {
  readonly name: string;
  send(token: string | null): Test;
}
const withAuth = (t: Test, token: string | null): Test => (token === null ? t : t.set(bearer(token)));
const ROUTES: readonly RouteCase[] = [
  { name: "GET /v1/me/notification-preferences", send: (t) => withAuth(h.http().get("/v1/me/notification-preferences"), t) },
  {
    name: "PATCH /v1/me/notification-preferences",
    send: (t) => withAuth(h.http().patch("/v1/me/notification-preferences").set("If-Match", '"x"').send({ types: [{ type: "PLUS", enabled: false }] }), t),
  },
  {
    name: "PUT /v1/me/devices/push-token",
    send: (t) => withAuth(h.http().put("/v1/me/devices/push-token").send({ install_id: INSTALL, platform: "ios", push_token: "tokentoken123" }), t),
  },
  { name: "GET /v1/me/notifications", send: (t) => withAuth(h.http().get("/v1/me/notifications"), t) },
  { name: "POST /v1/me/notifications/read", send: (t) => withAuth(h.http().post("/v1/me/notifications/read").send({ ids: [MISSING] }), t) },
];

describe("authorization (every endpoint)", () => {
  it.each(ROUTES.map((r) => r.name))("%s -> 401 unauthenticated and for a bad token", async (name) => {
    const r = ROUTES.find((x) => x.name === name);
    if (r === undefined) throw new Error("unreachable");
    expect((await r.send(null)).status).toBe(401);
    expect((await r.send("not-a-token")).status).toBe(401);
  });

  it.each(ROUTES.map((r) => r.name))("%s -> 401 for a seller_api token", async (name) => {
    const r = ROUTES.find((x) => x.name === name);
    if (r === undefined) throw new Error("unreachable");
    expect((await r.send(await mint(a, name, "seller_api"))).status).toBe(401);
  });

  it.each(ROUTES.map((r) => r.name))("%s -> 403 for a suspended subject", async (name) => {
    const r = ROUTES.find((x) => x.name === name);
    if (r === undefined) throw new Error("unreachable");
    const authn = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false });
    const original = authn.authenticate.bind(authn);
    authn.authenticate = async (t, n) => {
      const p = await original(t, n);
      return p === null ? null : { ...p, actor: { ...p.actor, status: "suspended" } };
    };
    try {
      const res = await r.send(await mint(a, `s-${name}`));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("account_not_active");
    } finally {
      authn.authenticate = original;
    }
  });

  it("POST /v1/me/notifications/read -> 404 for another user's item, identical to a missing one, nothing marked", async () => {
    const mine = await makeInboxItem(a, "authz-a");
    const theirs = await makeInboxItem(b, "authz-b");
    const foreign = await h.http().post("/v1/me/notifications/read").set(bearer(await mint(a, "f"))).send({ ids: [mine, theirs] });
    const missing = await h.http().post("/v1/me/notifications/read").set(bearer(await mint(a, "m"))).send({ ids: [mine, MISSING] });
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    const { request_id: _a, ...f } = foreign.body as Record<string, unknown>;
    const { request_id: _b, ...m } = missing.body as Record<string, unknown>;
    expect(f).toEqual(m);
    // all or nothing: neither the caller's own item nor the foreign one changed
    expect(inboxRepo.all().find((x) => x.id === mine)?.readAtMs).toBeNull();
    expect(inboxRepo.all().find((x) => x.id === theirs)?.readAtMs).toBeNull();
  });

  it("GET /v1/me/notifications never returns another user's rows", async () => {
    const theirs = await makeInboxItem(b, "authz-list-b");
    const res = await h.http().get("/v1/me/notifications?limit=50").set(bearer(await mint(a, "l")));
    expect(res.status).toBe(200);
    expect((res.body.items as { id: string }[]).map((i) => i.id)).not.toContain(theirs);
  });

  it("PUT /v1/me/devices/push-token cannot overwrite another user's registration for the same install id", async () => {
    await h.http().put("/v1/me/devices/push-token").set(bearer(await mint(a, "t1"))).send({ install_id: INSTALL, platform: "ios", push_token: "a-user-token-1" });
    await h.http().put("/v1/me/devices/push-token").set(bearer(await mint(b, "t2"))).send({ install_id: INSTALL, platform: "android", push_token: "b-user-token-1" });
    expect((await tokens.active(a.userId)).map((t) => t.token)).toEqual(["a-user-token-1"]);
    expect((await tokens.active(b.userId)).map((t) => t.token)).toEqual(["b-user-token-1"]);
  });
});

describe("GET /v1/me/notification-preferences", () => {
  it("returns defaults with every marketing flag off (never pre-ticked), SMS off and quiet hours", async () => {
    const res = await h.http().get("/v1/me/notification-preferences").set(bearer(await mint(b, "g1")));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      push_marketing: false,
      whatsapp_marketing: false,
      sms_marketing: false,
      email_marketing: false,
      quiet_hours: { from: "23:00", to: "09:00", timezone: "Africa/Cairo" },
    });
    expect(res.body.types).toContainEqual({ type: "PROMOTIONS", enabled: true });
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it("supports If-None-Match with 304", async () => {
    const t = await mint(b, "g2");
    const first = await h.http().get("/v1/me/notification-preferences").set(bearer(t));
    const second = await h.http().get("/v1/me/notification-preferences").set(bearer(t)).set("If-None-Match", first.headers.etag as string);
    expect(second.status).toBe(304);
  });
});

describe("PATCH /v1/me/notification-preferences", () => {
  async function current(user: typeof a, tag: string) {
    const r = await h.http().get("/v1/me/notification-preferences").set(bearer(await mint(user, tag)));
    return { etag: r.headers.etag as string, body: r.body as Record<string, unknown> };
  }

  it("requires If-Match (428) and rejects a stale one (412)", async () => {
    const t = await mint(a, "p1");
    const none = await h.http().patch("/v1/me/notification-preferences").set(bearer(t)).send({ types: [{ type: "PLUS", enabled: false }] });
    expect(none.status).toBe(428);
    const stale = await h.http().patch("/v1/me/notification-preferences").set(bearer(t)).set("If-Match", '"stale"').send({ types: [{ type: "PLUS", enabled: false }] });
    expect(stale.status).toBe(412);
  });

  it("switches a type off and returns the new representation and ETag", async () => {
    const { etag } = await current(a, "p2");
    const res = await h
      .http()
      .patch("/v1/me/notification-preferences")
      .set(bearer(await mint(a, "p2b")))
      .set("If-Match", etag)
      .send({ types: [{ type: "PRICE_DROPS", enabled: false }, { type: "PROMOTIONS.push", enabled: false }] });
    expect(res.status).toBe(200);
    expect(res.body.types).toContainEqual({ type: "PRICE_DROPS", enabled: false });
    expect(res.body.types).toContainEqual({ type: "PROMOTIONS.push", enabled: false });
    expect(res.headers.etag).not.toBe(etag);
    // The other user is unaffected.
    const other = await current(b, "p2c");
    expect(other.body.types).toContainEqual({ type: "PRICE_DROPS", enabled: true });
  });

  it("422 for opting in without consent, SMS marketing and transactional types", async () => {
    const send = async (body: unknown, tag: string) => {
      const { etag } = await current(a, tag);
      return h.http().patch("/v1/me/notification-preferences").set(bearer(await mint(a, `${tag}b`))).set("If-Match", etag).send(body as object);
    };
    expect((await send({ push_marketing: true }, "r1")).body.code).toBe("consent_required");
    expect((await send({ sms_marketing: true }, "r2")).body.code).toBe("channel_not_supported");
    expect((await send({ types: [{ type: "ORDER_UPDATES", enabled: false }] }, "r3")).body.code).toBe("type_not_switchable");
  });

  it("one tap off withdraws consent and stops marketing push", async () => {
    consent.grant(a.userId, "marketing_push");
    const { etag, body } = await current(a, "u1");
    expect(body.push_marketing).toBe(true);
    const res = await h
      .http()
      .patch("/v1/me/notification-preferences")
      .set(bearer(await mint(a, "u1b")))
      .set("If-Match", etag)
      .send({ push_marketing: false });
    expect(res.status).toBe(200);
    expect(res.body.push_marketing).toBe(false);
    expect(await consent.isGranted(a.userId, "marketing_push")).toBe(false);
  });

  it("validates the body strictly (400)", async () => {
    const { etag } = await current(a, "v1");
    const t = await mint(a, "v1b");
    const patch = (body: unknown) => h.http().patch("/v1/me/notification-preferences").set(bearer(t)).set("If-Match", etag).send(body as object);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ user_id: b.userId, push_marketing: false })).status).toBe(400);
    expect((await patch({ types: [{ type: "plus", enabled: true }] })).status).toBe(400);
    expect((await patch({ types: [] })).status).toBe(400);
    expect((await patch({ push_marketing: "yes" })).status).toBe(400);
  });
});

describe("PUT /v1/me/devices/push-token", () => {
  it("stores the token and answers 204 with no body, never echoing the token", async () => {
    const res = await h.http().put("/v1/me/devices/push-token").set(bearer(await mint(a, "pt1"))).send({ install_id: INSTALL, platform: "ios", push_token: "rotating-token-1" });
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    await h.http().put("/v1/me/devices/push-token").set(bearer(await mint(a, "pt2"))).send({ install_id: INSTALL, platform: "ios", push_token: "rotating-token-2" });
    expect((await tokens.active(a.userId)).map((t) => t.token)).toEqual(["rotating-token-2"]);
  });

  it("rejects malformed bodies (400) and unknown fields", async () => {
    const t = await mint(a, "pt3");
    const put = (body: unknown) => h.http().put("/v1/me/devices/push-token").set(bearer(t)).send(body as object);
    expect((await put({ install_id: "nope", platform: "ios", push_token: "tokentoken1" })).status).toBe(400);
    expect((await put({ install_id: INSTALL, platform: "web", push_token: "tokentoken1" })).status).toBe(400);
    expect((await put({ install_id: INSTALL, platform: "ios", push_token: "x".repeat(513) })).status).toBe(400);
    expect((await put({ install_id: INSTALL, platform: "ios", push_token: "has space token" })).status).toBe(400);
    expect((await put({ install_id: INSTALL, platform: "ios", push_token: "tokentoken1", user_id: b.userId })).status).toBe(400);
  });

  it("a registered token receives a real transactional push through the module", async () => {
    await h.http().put("/v1/me/devices/push-token").set(bearer(await mint(b, "pt4"))).send({ install_id: INSTALL, platform: "ios", push_token: "b-delivery-token" });
    const before = push.sent.length;
    const res = await sender.execute({ userId: b.userId, templateKey: "order_shipped", ref: "http-push", payload: { order_no: "Z1" } });
    expect(res).toMatchObject({ kind: "accepted", channel: "push" });
    expect(push.sent.length).toBe(before + 1);
    expect(push.sent.at(-1)?.to).toBe("b-delivery-token");
    expect(push.sent.at(-1)?.body).toBe("Your order Z1 has shipped.");
  });
});

describe("inbox", () => {
  it("lists newest first with cursor pagination, localized text and unread state", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      h.clock.advance(1000);
      ids.push(await makeInboxItem(b, `page-${i}`));
    }
    const t = await mint(b, "i1");
    const first = await h.http().get("/v1/me/notifications?limit=2").set(bearer(t));
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.items.map((i: { id: string }) => i.id)).toEqual([ids[4], ids[3]]);
    expect(first.body.page.has_more).toBe(true);
    expect(first.body.items[0]).toMatchObject({
      type: "REFUNDS",
      title: { ar: "تم رد المبلغ", en: "Refund completed" },
      read_at: null,
    });
    const second = await h.http().get(`/v1/me/notifications?limit=2&cursor=${encodeURIComponent(first.body.page.next_cursor)}`).set(bearer(t));
    expect(second.body.items.map((i: { id: string }) => i.id)).toEqual([ids[2], ids[1]]);
    const third = await h.http().get(`/v1/me/notifications?limit=2&cursor=${encodeURIComponent(second.body.page.next_cursor)}`).set(bearer(t));
    expect(third.body.items[0].id).toBe(ids[0]);
  });

  it("rejects a malformed cursor and out-of-range limits with 400", async () => {
    const t = await mint(a, "i2");
    expect((await h.http().get("/v1/me/notifications?cursor=%%%").set(bearer(t))).status).toBe(400);
    expect((await h.http().get("/v1/me/notifications?cursor=bm9wZQ").set(bearer(t))).status).toBe(400);
    expect((await h.http().get("/v1/me/notifications?limit=0").set(bearer(t))).status).toBe(400);
    expect((await h.http().get("/v1/me/notifications?limit=51").set(bearer(t))).status).toBe(400);
  });

  it("marks items read, idempotently, and hides expired rows", async () => {
    const id = await makeInboxItem(a, "read-1");
    const t = await mint(a, "i3");
    expect((await h.http().post("/v1/me/notifications/read").set(bearer(t)).send({ ids: [id, id] })).status).toBe(204);
    expect((await h.http().post("/v1/me/notifications/read").set(bearer(t)).send({ ids: [id] })).status).toBe(204);
    const list = await h.http().get("/v1/me/notifications?limit=50").set(bearer(await mint(a, "i3b")));
    expect(list.body.items.find((i: { id: string }) => i.id === id)?.read_at).toEqual(expect.any(String));
    h.clock.advance(91 * 86_400_000);
    const later = await h.http().get("/v1/me/notifications?limit=50").set(bearer(await mint(a, "i3c")));
    expect(later.body.items.find((i: { id: string }) => i.id === id)).toBeUndefined();
  });

  it("validates the read body (400): empty, too many, not uuids, extra keys", async () => {
    const t = await mint(a, "i4");
    const post = (body: unknown) => h.http().post("/v1/me/notifications/read").set(bearer(t)).send(body as object);
    expect((await post({ ids: [] })).status).toBe(400);
    expect((await post({ ids: Array.from({ length: 101 }, () => MISSING) })).status).toBe(400);
    expect((await post({ ids: ["x"] })).status).toBe(400);
    expect((await post({ ids: [MISSING], all: true })).status).toBe(400);
  });
});
