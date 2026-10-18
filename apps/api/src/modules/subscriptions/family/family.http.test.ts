import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Actor } from "@outlet/policy";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng } from "../../../platform";
import {
  FakeAgePolicy,
  FakeCardVault,
  FakeFlags,
  FakeLedger,
  FakeNotices,
  FakePersonKeys,
  FakePlanApprovals,
  FakeRecurringCharges,
  FakeRefunds,
  FakeTaxReceipts,
  HmacKeyHasher,
  InMemorySubscriptionStore,
} from "../adapters/in-memory";
import { PLUS_FLAGS } from "../domain/ports";
import { SubscriptionsModule } from "../subscriptions.module";
import { FakeClock, TokenTable, U, bearer, idem } from "../test/http-harness";
import {
  FakeFamilyIdentity,
  FakeInviteDelivery,
  FakeStudentVerifier,
  InMemoryFamilyStore,
  InMemoryStudentStore,
  SequentialInviteTokens,
} from "./in-memory";

const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });
const IDS = { owner: U(1), member: U(2), young: U(3), stranger: U(4), rival: U(5) };
const TOK = {
  owner: "token-fam-owner-00000000000000001",
  member: "token-fam-member-0000000000000002",
  young: "token-fam-young-00000000000000003",
  stranger: "token-fam-stranger-00000000000004",
  rival: "token-fam-rival-000000000000000005",
  seller: "token-fam-seller-00000000000000006",
};
const PHONE = (n: number): string => `+2010000000${n}`;

let app: INestApplication;
let clock: FakeClock;
let delivery: FakeInviteDelivery;
let flags: FakeFlags;
let identity: FakeFamilyIdentity;
let verifier: FakeStudentVerifier;
let familyStore: InMemoryFamilyStore;

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: "test" });
  clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const table = new TokenTable();
  table.add(TOK.owner, { actor: shopper(IDS.owner), aud: "buyer_api" });
  table.add(TOK.member, { actor: shopper(IDS.member), aud: "buyer_api" });
  table.add(TOK.young, { actor: shopper(IDS.young), aud: "buyer_api" });
  table.add(TOK.stranger, { actor: shopper(IDS.stranger), aud: "buyer_api" });
  table.add(TOK.rival, { actor: shopper(IDS.rival), aud: "buyer_api" });
  table.add(TOK.seller, { actor: { ...shopper(U(11)), grants: [{ kind: "brand", storeId: U(9001), role: "owner" }] }, aud: "seller_api" });

  @Global()
  @Module({})
  class TestAuth {
    static register(): DynamicModule {
      return { module: TestAuth, providers: [{ provide: AUTHENTICATOR, useValue: table }], exports: [AUTHENTICATOR] };
    }
  }

  const store = new InMemorySubscriptionStore();
  store.seedDefaultPlans(ids);
  await store.savePlan(
    { id: ids.uuidV7(), code: "plus_family", kind: "family", seatLimit: 4, interval: "year", priceMinor: 120_000n, version: 1, active: true, trialDays: 0, effectiveFromMs: 0, notifiedAtMs: null },
    [],
  );
  const ages = new FakeAgePolicy();
  const persons = new FakePersonKeys();
  const vault = new FakeCardVault();
  identity = new FakeFamilyIdentity("http-family");
  const ageOf: Record<string, number> = { [IDS.owner]: 35, [IDS.member]: 30, [IDS.young]: 19, [IDS.stranger]: 40, [IDS.rival]: 33 };
  Object.entries(IDS).forEach(([, id], i) => {
    ages.setAge(id, ageOf[id] ?? 30);
    persons.set(id, identity.register(id, PHONE(i + 1)));
    vault.add(id, `tok_${i + 1}`, `fp-${i + 1}`);
  });
  delivery = new FakeInviteDelivery();
  flags = new FakeFlags();
  verifier = new FakeStudentVerifier();
  familyStore = new InMemoryFamilyStore();

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuth.register(),
      SubscriptionsModule.forRoot(config, {
        store,
        ages,
        persons,
        vault,
        charges: new FakeRecurringCharges(),
        refunds: new FakeRefunds(),
        ledger: new FakeLedger(),
        receipts: new FakeTaxReceipts(),
        notices: new FakeNotices(),
        flags,
        approvals: new FakePlanApprovals(),
        hasher: new HmacKeyHasher("http-family-hash"),
        familyStore,
        studentStore: new InMemoryStudentStore(),
        familyIdentity: identity,
        inviteDelivery: delivery,
        inviteTokens: new SequentialInviteTokens(),
        studentVerifier: verifier,
      }),
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  configureApp(app, config);
  await app.init();
}, 60_000);
afterAll(async () => {
  await app.close();
});

const http = () => request(app.getHttpServer());
const tick = (): void => clock.advance(601_000);
const post = (path: string, token: string | null, body: unknown = {}, extra: Record<string, string> = idem()) => {
  tick();
  const r = http().post(path).set(extra);
  return (token === null ? r : r.set(bearer(token))).send(body as object);
};
const get = (path: string, token: string | null = null) => {
  tick();
  const r = http().get(path);
  return token === null ? r : r.set(bearer(token));
};
const del = (path: string, token: string | null, extra: Record<string, string> = idem()) => {
  tick();
  const r = http().delete(path).set(extra);
  return token === null ? r : r.set(bearer(token));
};

let memberSeatId = "";
let inviteToken = "";

describe("authentication and audience", () => {
  it("every family and student route needs a bearer token", async () => {
    const memberId = U(900);
    for (const [m, p] of [
      ["post", "/v1/plus/family"],
      ["get", "/v1/me/plus/family"],
      ["post", "/v1/plus/family/invites"],
      ["delete", `/v1/plus/family/invites/${memberId}`],
      ["post", "/v1/plus/family/invites/abcdefghijklmnop1234/accept"],
      ["delete", `/v1/plus/family/members/${memberId}`],
      ["post", "/v1/plus/family/leave"],
      ["post", "/v1/plus/student/verify"],
      ["get", "/v1/me/plus/student"],
    ] as const) {
      const r = m === "get" ? await get(p) : m === "post" ? await post(p, null) : await del(p, null);
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });

  it("seller tokens are not accepted on the buyer API", async () => {
    expect((await get("/v1/me/plus/family", TOK.seller)).status).toBe(401);
    expect((await post("/v1/plus/family/leave", TOK.seller)).status).toBe(401);
  });

  it("writes need an Idempotency-Key", async () => {
    expect((await post("/v1/plus/family/leave", TOK.owner, {}, {})).status).toBe(400);
    expect((await del(`/v1/plus/family/members/${U(900)}`, TOK.owner, {})).status).toBe(400);
    expect((await post("/v1/plus/family", TOK.owner, { payment_token_ref: "tok_1" }, {})).status).toBe(400);
  });
});

describe("create and view", () => {
  it("the paywall lists family and student plan kinds and the derived family offer", async () => {
    const r = await get("/v1/plus/plans", TOK.owner);
    expect(r.status).toBe(200);
    const fam = r.body.plans.find((p: { code: string }) => p.code === "plus_family");
    expect(fam).toMatchObject({ kind: "family", seat_limit: 4, price: { amount_minor: "120000" } });
    expect(r.body.family_offer).toEqual({ plan_code: "plus_family", seats: 4, saving: { amount_minor: "200000", currency: "EGP" } });
    expect(r.body.yearly_offer).toMatchObject({ pay_months: 4, free_months: 8 });
  });

  it("creates the family subscription and returns the group with the owner on seat 1", async () => {
    const bad = await post("/v1/plus/family", TOK.owner, { payment_token_ref: "tok_1", plan_code: "plus_yearly" });
    expect(bad.status).toBe(400);
    const r = await post("/v1/plus/family", TOK.owner, { payment_token_ref: "tok_1", method: "card" });
    expect(r.status).toBe(201);
    expect(r.body.subscription.plan_code).toBe("plus_family");
    expect(r.body.family).toMatchObject({ role: "owner", seat_limit: 4, seats_held: 1, seats_free: 3 });
    const mine = await get("/v1/me/plus/family", TOK.owner);
    expect(mine.status).toBe(200);
    expect(mine.body.members).toHaveLength(1);
  });

  it("a person with no family gets 404", async () => {
    expect((await get("/v1/me/plus/family", TOK.stranger)).status).toBe(404);
  });
});

describe("invites", () => {
  it("validates the body strictly and enforces ownership", async () => {
    expect((await post("/v1/plus/family/invites", TOK.owner, { phone: "0100" })).status).toBe(400);
    expect((await post("/v1/plus/family/invites", TOK.owner, { phone: PHONE(2), user_id: IDS.member })).status).toBe(400);
    const notOwner = await post("/v1/plus/family/invites", TOK.stranger, { phone: PHONE(2) });
    expect(notOwner.status).toBe(404);
  });

  it("sends an invite: 201 with the seat id, the token goes to delivery and never to the response", async () => {
    const r = await post("/v1/plus/family/invites", TOK.owner, { phone: PHONE(2), nickname: "Sara" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "INVITED" });
    memberSeatId = r.body.id as string;
    inviteToken = delivery.last()?.token ?? "";
    expect(inviteToken.length).toBeGreaterThan(16);
    expect(JSON.stringify(r.body)).not.toContain(inviteToken);
    expect(JSON.stringify(r.body)).not.toContain(PHONE(2));
  });

  it("refuses an under-age invitee with the policy reason and a duplicate pending invite", async () => {
    const young = await post("/v1/plus/family/invites", TOK.owner, { phone: PHONE(3) });
    expect(young.status).toBe(403);
    expect(young.body).toMatchObject({ code: "age_gate", min_age: 21 });
    const dup = await post("/v1/plus/family/invites", TOK.owner, { phone: PHONE(2) });
    expect(dup.status).toBe(422);
    expect(dup.body.code).toBe("invite_already_invited");
  });

  it("a delivery failure answers 503 and releases the seat", async () => {
    delivery.failNext = true;
    const r = await post("/v1/plus/family/invites", TOK.owner, { phone: PHONE(4) });
    expect(r.status).toBe(503);
    const mine = await get("/v1/me/plus/family", TOK.owner);
    expect(mine.body.seats_held).toBe(2);
  });
});

describe("accept", () => {
  it("rejects a malformed token, a wrong person and an unknown token with the same 404 or 400", async () => {
    expect((await post("/v1/plus/family/invites/short/accept", TOK.member, {})).status).toBe(400);
    expect((await post(`/v1/plus/family/invites/${inviteToken}/accept`, TOK.stranger, {})).status).toBe(404);
    expect((await post("/v1/plus/family/invites/zzzzzzzzzzzzzzzzzzzzzz/accept", TOK.member, {})).status).toBe(404);
  });

  it("the invited, OTP verified person accepts and gets the entitlements; the member view hides the family", async () => {
    const r = await post(`/v1/plus/family/invites/${inviteToken}/accept`, TOK.member, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ accepted: true, own_plan_ending: false });
    const mine = await get("/v1/me/plus", TOK.member);
    expect(mine.body.entitlements.active).toBe(true);
    expect(mine.body.subscription).toBeNull();
    const view = await get("/v1/me/plus/family", TOK.member);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ role: "member", seat_status: "ACTIVE" });
    expect(view.body).not.toHaveProperty("members");
    expect(JSON.stringify(view.body)).not.toContain(IDS.owner);
    const again = await post(`/v1/plus/family/invites/${inviteToken}/accept`, TOK.member, {});
    expect([404, 409, 410]).toContain(again.status);
  });

  it("the owner view lists nicknames and never user ids or phones", async () => {
    const r = await get("/v1/me/plus/family", TOK.owner);
    expect(r.body.members.map((m: { nickname: string | null }) => m.nickname)).toEqual([null, "Sara"]);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(IDS.member);
    expect(text).not.toContain("phone");
  });
});

describe("remove and leave: BOLA", () => {
  it("another family owner, the member and a stranger all get 404 for someone else's seat", async () => {
    await post("/v1/plus/family", TOK.rival, { payment_token_ref: "tok_5" });
    for (const t of [TOK.rival, TOK.member, TOK.stranger]) {
      const r = await del(`/v1/plus/family/members/${memberSeatId}`, t);
      expect(r.status, t).toBe(404);
      const rv = await del(`/v1/plus/family/invites/${memberSeatId}`, t);
      expect(rv.status, t).toBe(404);
    }
    expect((await del("/v1/plus/family/members/not-a-uuid", TOK.owner)).status).toBe(400);
    const stillThere = await get("/v1/me/plus/family", TOK.member);
    expect(stillThere.body.seat_status).toBe("ACTIVE");
  });

  it("the owner cannot leave and a stranger leaving gets 404", async () => {
    const o = await post("/v1/plus/family/leave", TOK.owner, {});
    expect(o.status).toBe(422);
    expect(o.body.code).toBe("owner_cannot_leave");
    expect((await post("/v1/plus/family/leave", TOK.stranger, {})).status).toBe(404);
  });

  it("the owner removes the member: seat ends at the period end and the benefit stays until then", async () => {
    const r = await del(`/v1/plus/family/members/${memberSeatId}`, TOK.owner);
    expect(r.status).toBe(200);
    expect(r.body.removed).toBe(true);
    const mine = await get("/v1/me/plus", TOK.member);
    expect(mine.body.entitlements.ends_at).toBe(r.body.seat_end_at);
  });

  it("the kill switch answers 503 for invites, removals and leaving", async () => {
    flags.disable(PLUS_FLAGS.family);
    expect((await post("/v1/plus/family/invites", TOK.owner, { phone: PHONE(4) })).status).toBe(503);
    expect((await del(`/v1/plus/family/members/${memberSeatId}`, TOK.owner)).status).toBe(503);
    expect((await post("/v1/plus/family/leave", TOK.member, {})).status).toBe(503);
    flags.enable(PLUS_FLAGS.family);
  });

  it("invites are rate limited to 10 per minute per user", async () => {
    clock.advance(601_000);
    const send = () =>
      http().post("/v1/plus/family/invites").set(idem()).set(bearer(TOK.rival)).send({ phone: "+201000000099" });
    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) codes.push((await send()).status);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});

describe("student", () => {
  it("verify validates the method, fails closed on a disallowed domain and starts a verification", async () => {
    expect((await post("/v1/plus/student/verify", TOK.stranger, { method: "university_email" })).status).toBe(400);
    expect((await post("/v1/plus/student/verify", TOK.stranger, { method: "university_email", university_email: "a@gmail.com" })).status).toBe(422);
    const r = await post("/v1/plus/student/verify", TOK.stranger, { method: "university_email", university_email: "a@cu.edu.eg" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "PENDING", client_action: { type: "redirect" } });
    const st = await get("/v1/me/plus/student", TOK.stranger);
    expect(st.body).toEqual({ status: "PENDING", valid_until: null, price_applies: false });
  });

  it("the callback is MAC authenticated, idempotent and gives the status to the right user only", async () => {
    const ref = verifier.started[verifier.started.length - 1] ? `fake-ref-${verifier.started.length}` : "";
    tick();
    const forged = await http().post("/v1/plus/student/verify/callback").send({ kind: "verified", ref });
    expect(forged.status).toBe(401);
    tick();
    const ok = await http().post("/v1/plus/student/verify/callback").set("x-verifier-signature", "ok").send({ kind: "verified", ref });
    expect(ok.status).toBe(200);
    tick();
    const replay = await http().post("/v1/plus/student/verify/callback").set("x-verifier-signature", "ok").send({ kind: "verified", ref });
    expect(replay.status).toBe(200);
    const mine = await get("/v1/me/plus/student", TOK.stranger);
    expect(mine.body).toMatchObject({ status: "VERIFIED", price_applies: true });
    expect((await get("/v1/me/plus/student", TOK.owner)).body).toMatchObject({ status: "NONE", price_applies: false });
  });

  it("subscribing to the student plan without a verified status is 403; the kill switch is 503", async () => {
    const r = await post("/v1/plus/subscribe", TOK.young, { plan_code: "plus_student", payment_token_ref: "tok_3" });
    expect([403]).toContain(r.status);
    flags.disable(PLUS_FLAGS.student);
    const k = await post("/v1/plus/student/verify", TOK.young, { method: "verifier_session" });
    expect(k.status).toBe(503);
    flags.enable(PLUS_FLAGS.student);
  });
});
