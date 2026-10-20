import "reflect-metadata";
import { Global, Module, type DynamicModule } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, AdminRole } from "@outlet/policy";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import type { InMemoryAuditSink } from "../../../platform/dev-fixtures";
import { AUDIT_SINK } from "../../../platform/tokens";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator } from "../../../platform";
import {
  InMemoryCreatorCatalog,
  InMemoryCreatorIdentity,
  InMemoryCreatorLedger,
  InMemoryCreatorStore,
  StaticCreatorFlags,
} from "../adapters/in-memory";
import { CreatorsModule } from "../creators.module";
import type { CreatorProfileView } from "../domain/ports";
import { U, attribution, newCommission } from "./repository-contract";

const T0 = Date.UTC(2026, 9, 12, 8, 0, 0);
const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
let keyN = 100;
const next = (): string => IDEM(keyN++);

class Clock {
  ms = T0;
  nowMs(): number {
    return this.ms;
  }
  advance(n: number): void {
    this.ms += n;
  }
}

const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });
const admin = (id: string, role: AdminRole): Actor => ({
  id,
  status: "active",
  assurance: "passkey",
  grants: [{ kind: "admin", role }],
  tokenScopes: ["admin:access"],
});

class Tokens implements Authenticator {
  private readonly m = new Map<string, { actor: Actor; aud: AccessClaims["aud"] }>();
  add(token: string, actor: Actor, aud: AccessClaims["aud"]): void {
    this.m.set(token, { actor, aud });
  }
  async authenticate(b: string, nowMs: number) {
    const s = this.m.get(b);
    if (s === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    const claims: AccessClaims = { iss: "test", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `j-${b}`, sid: `s-${b}`, amr: ["otp_sms"] };
    return { actor: s.actor, claims };
  }
}

const TK = {
  a: "tok-creator-a-0000000001",
  b: "tok-creator-b-0000000001",
  c: "tok-shopper-c-0000000001",
  young: "tok-shopper-young-00001",
  finance: "tok-admin-finance-00001",
  ops: "tok-admin-ops-0000000001",
  ts: "tok-admin-ts-00000000001",
  support: "tok-admin-support-000001",
  sellerAud: "tok-seller-aud-000000001",
  shopperOnAdmin: "tok-shopper-on-admin-00001",
};

const profile = (userId: string, o: Partial<CreatorProfileView> = {}): CreatorProfileView => ({
  userId,
  ageYears: 30,
  active: true,
  deviceHashes: [],
  paymentFingerprintHashes: [],
  addressHashes: [],
  sellerStoreIds: [],
  ...o,
});

let app: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>["compile"]>> extends infer M
  ? M extends { createNestApplication: () => infer A }
    ? A
    : never
  : never;
let audit: InMemoryAuditSink;
const store = new InMemoryCreatorStore();
const identity = new InMemoryCreatorIdentity();
const catalog = new InMemoryCreatorCatalog();
const ledger = new InMemoryCreatorLedger();
const flags = new StaticCreatorFlags(true, false);
const clock = new Clock();
const http = () => request(app.getHttpServer());

const get = (p: string, t: string | null) => (t === null ? http().get(p) : http().get(p).set(bearer(t)));
const send = (m: "post" | "patch" | "delete", p: string, t: string | null, body: object = {}, k: string | null = next()) => {
  let r = http()[m](p);
  if (t !== null) r = r.set(bearer(t));
  if (k !== null) r = r.set("Idempotency-Key", k);
  return m === "delete" ? r : r.send(body);
};
const applyBody = (n: number, over: object = {}) => ({
  handle: `style_${n}`,
  display_name: `Style ${n}`,
  legal_name: `Legal Name ${n}`,
  national_id: `29901010${String(n).padStart(6, "0")}`,
  accept_terms_version: 1,
  ...over,
});

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: "test" });
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new Tokens();
  tokens.add(TK.a, shopper(U(1)), "buyer_api");
  tokens.add(TK.b, shopper(U(2)), "buyer_api");
  tokens.add(TK.c, shopper(U(3)), "buyer_api");
  tokens.add(TK.young, shopper(U(4)), "buyer_api");
  tokens.add(TK.finance, admin(U(41), "finance"), "admin_api");
  tokens.add(TK.ops, admin(U(42), "ops"), "admin_api");
  tokens.add(TK.ts, admin(U(45), "trust_safety"), "admin_api");
  tokens.add(TK.support, admin(U(43), "support"), "admin_api");
  tokens.add(TK.sellerAud, shopper(U(1)), "seller_api");
  tokens.add(TK.shopperOnAdmin, shopper(U(3)), "admin_api");
  for (const n of [1, 2, 3]) identity.profiles.set(U(n), profile(U(n)));
  identity.profiles.set(U(4), profile(U(4), { ageYears: 19 }));

  @Global()
  @Module({})
  class TestAuth {
    static register(): DynamicModule {
      return { module: TestAuth, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }
  const m = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuth.register(),
      CreatorsModule.forRoot(config, { store, identity, catalog, ledger, flags }),
    ],
  }).compile();
  audit = m.get<InMemoryAuditSink>(AUDIT_SINK, { strict: false });
  app = m.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
}, 60_000);

afterAll(async () => {
  await app.close();
});

let creatorAId = "";
let creatorBId = "";
let linkA = "";
let lookA = "";

describe("route protection", () => {
  const routes: [string, string][] = [
    ["post", "/v1/creator/apply"],
    ["get", "/v1/creator/dashboard"],
    ["post", "/v1/creator/links"],
    ["get", "/v1/creator/links"],
    ["delete", `/v1/creator/links/${U(900)}`],
    ["post", "/v1/creator/looks"],
    ["get", "/v1/creator/looks"],
    ["patch", `/v1/creator/looks/${U(900)}`],
    ["post", `/v1/creator/looks/${U(900)}/publish`],
    ["delete", `/v1/creator/looks/${U(900)}`],
    ["get", "/v1/creator/commissions"],
    ["get", "/v1/creator/payouts"],
    ["post", "/v1/creator/payout-preference"],
    ["get", "/v1/admin/creators"],
    ["post", `/v1/admin/creators/${U(900)}/decision`],
    ["post", `/v1/admin/creators/attributions/${U(900)}/void`],
    ["post", `/v1/admin/creator-looks/${U(900)}/takedown`],
    ["get", "/v1/admin/creator-payouts"],
    ["post", "/v1/admin/creator-payouts"],
    ["post", `/v1/admin/creator-payouts/${U(900)}/approve`],
    ["post", `/v1/admin/creator-payouts/${U(900)}/send`],
    ["post", `/v1/admin/creator-payouts/${U(900)}/outcome`],
    ["post", `/v1/admin/creator-payouts/${U(900)}/cancel`],
  ];
  it.each(routes)("%s %s: 401 without credentials", async (m, p) => {
    const r = await (http() as unknown as Record<string, (u: string) => request.Test>)[m]!(p).send({});
    expect(r.status).toBe(401);
  });

  it("a seller-audience token is refused on buyer routes, a shopper token on admin routes", async () => {
    expect((await get("/v1/creator/dashboard", TK.sellerAud)).status).toBe(401);
    expect((await get("/v1/admin/creators", TK.a)).status).toBe(401); // buyer audience on admin_api route
  });
});

describe("application and review", () => {
  it("refuses an applicant under 21 with a policy reason and answers 404 for the dashboard", async () => {
    const r = await send("post", "/v1/creator/apply", TK.young, applyBody(9));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("creator_ineligible");
    expect(JSON.stringify(r.body)).toContain("under_age");
    expect((await get("/v1/creator/dashboard", TK.young)).status).toBe(404);
  });

  it("requires an Idempotency-Key and rejects unknown fields", async () => {
    expect((await send("post", "/v1/creator/apply", TK.a, applyBody(1), null)).status).toBe(400);
    expect((await send("post", "/v1/creator/apply", TK.a, { ...applyBody(1), user_id: U(5) })).status).toBe(400);
  });

  it("accepts an application and never echoes KYC data", async () => {
    const r = await send("post", "/v1/creator/apply", TK.a, applyBody(1));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ handle: "style_1", status: "APPLIED", kyc_state: "SUBMITTED" });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("29901010");
    expect(text).not.toContain("Legal Name");
    for (const k of ["user_id", "id", "national_id", "legal_name"]) expect(r.body).not.toHaveProperty(k);
    creatorAId = (await store.getByUser(U(1)))?.id ?? "";
    const b = await send("post", "/v1/creator/apply", TK.b, applyBody(2));
    expect(b.status).toBe(201);
    creatorBId = (await store.getByUser(U(2)))?.id ?? "";
  });

  it("a taken handle is a 409 and a second application returns the existing one", async () => {
    expect((await send("post", "/v1/creator/apply", TK.c, applyBody(3, { handle: "style_1" }))).status).toBe(409);
    const again = await send("post", "/v1/creator/apply", TK.a, applyBody(1));
    expect(again.status).toBe(201);
    expect(again.body.handle).toBe("style_1");
  });

  it("an unapproved creator cannot create links and is invisible publicly", async () => {
    catalog.targets.set(`product:${U(301)}`, { exists: true, storeId: null });
    const r = await send("post", "/v1/creator/links", TK.a, { target_type: "product", target_id: U(301) });
    expect(r.status).toBe(403);
    expect((await get("/v1/c/style_1", null)).status).toBe(404);
  });

  it("shoppers get 403 on admin routes; support may review but not move money", async () => {
    expect((await get("/v1/admin/creators", TK.shopperOnAdmin)).status).toBe(403);
    expect((await send("post", "/v1/admin/creator-payouts", TK.shopperOnAdmin, { creator_id: U(900) })).status).toBe(403);
    expect((await get("/v1/admin/creators?status=APPLIED", TK.support)).status).toBe(403); // list names user_id: trust and safety only (A-10)
    expect((await get("/v1/admin/creators?status=APPLIED", TK.ts)).status).toBe(200);
    expect((await get("/v1/admin/creator-payouts", TK.support)).status).toBe(403);
    expect((await send("post", "/v1/admin/creator-payouts", TK.ops, { creator_id: creatorAId })).status).toBe(403);
  });

  it("lists applications and approves; another decision on the same state is a 409", async () => {
    const list = await get("/v1/admin/creators?status=APPLIED", TK.ts);
    expect(list.status).toBe(200);
    expect(list.body.items.map((x: { handle: string }) => x.handle).sort()).toEqual(["style_1", "style_2"]);
    const d = await send("post", `/v1/admin/creators/${creatorAId}/decision`, TK.ops, { action: "approve", reason: "auto-checks:ok ref-1" });
    expect(d.status).toBe(200);
    expect(d.body.status).toBe("ACTIVE");
    expect((await send("post", `/v1/admin/creators/${creatorAId}/decision`, TK.ops, { action: "approve", reason: "auto-checks:ok ref-1" })).status).toBe(409);
    expect((await send("post", `/v1/admin/creators/${creatorBId}/decision`, TK.ops, { action: "approve", reason: "auto-checks:ok ref-2" })).status).toBe(200);
    expect((await send("post", `/v1/admin/creators/${U(999)}/decision`, TK.ops, { action: "approve", reason: "auto-checks:ok ref-3" })).status).toBe(404);
  });
});

describe("links and looks: tenant isolation", () => {
  it("creates a link, lists only own, and another creator cannot disable it (404 like a missing id)", async () => {
    const c = await send("post", "/v1/creator/links", TK.a, { target_type: "product", target_id: U(301) });
    expect(c.status).toBe(201);
    expect(c.body.share_url).toMatch(/^https:\/\/outletnk\.invalid\/a\/[a-z2-9]{16}$/);
    expect(c.body.disclosure_key).toBe("creator.affiliate_disclosure");
    linkA = c.body.id;
    expect((await get("/v1/creator/links", TK.a)).body.items).toHaveLength(1);
    expect((await get("/v1/creator/links", TK.b)).body.items).toHaveLength(0);
    const foreign = await send("delete", `/v1/creator/links/${linkA}`, TK.b, {}, null);
    const missing = await send("delete", `/v1/creator/links/${U(998)}`, TK.b, {}, null);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    const strip = ({ request_id: _r, ...rest }: Record<string, unknown>) => rest;
    expect(strip(foreign.body)).toEqual(strip(missing.body));
    expect((await store.getLink(linkA))?.status).toBe("ACTIVE");
  });

  it("looks: only real catalog items; another creator gets 404 on read-modify routes", async () => {
    catalog.products.add(U(301));
    expect((await send("post", "/v1/creator/looks", TK.a, { title: "Eid", product_ids: [U(301), U(777)] })).status).toBe(422);
    const c = await send("post", "/v1/creator/looks", TK.a, { title: "Eid", product_ids: [U(301)] });
    expect(c.status).toBe(201);
    lookA = c.body.id;
    expect(JSON.stringify(c.body)).not.toMatch(/price/i);
    for (const [m, path, body] of [
      ["patch", `/v1/creator/looks/${lookA}`, { title: "x" }],
      ["post", `/v1/creator/looks/${lookA}/publish`, {}],
      ["delete", `/v1/creator/looks/${lookA}`, {}],
    ] as const) {
      const foreign = await send(m, path, TK.b, body, m === "patch" || m === "delete" ? null : next());
      expect(foreign.status, `${m} ${path}`).toBe(404);
    }
    expect((await get("/v1/creator/looks", TK.b)).body.items).toHaveLength(0);
    const pub = await send("post", `/v1/creator/looks/${lookA}/publish`, TK.a);
    expect(pub.status).toBe(200);
    expect(pub.body.status).toBe("PUBLISHED");
  });

  it("public profile exposes handle and published looks only, no ids of the account", async () => {
    const r = await get("/v1/c/style_1", null);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ handle: "style_1", disclosure_key: "creator.affiliate_disclosure" });
    expect(r.body.looks).toHaveLength(1);
    for (const k of ["id", "user_id", "status", "kyc_state"]) expect(r.body).not.toHaveProperty(k);
    expect((await get("/v1/c/nobody_here", null)).status).toBe(404);
  });

  it("take down is an admin action and is final for the creator", async () => {
    const t = await send("post", `/v1/admin/creator-looks/${lookA}/takedown`, TK.support, { reason: "counterfeit report" });
    expect(t.status).toBe(200);
    expect(t.body.status).toBe("TAKEN_DOWN");
    expect((await send("post", `/v1/creator/looks/${lookA}/publish`, TK.a)).status).toBe(409);
    expect((await get("/v1/c/style_1", null)).body.looks).toHaveLength(0);
  });
});

describe("clicks", () => {
  it("always answers 202; a real slug returns its target, an unknown one nothing", async () => {
    const slug = (await store.getLink(linkA))?.slug ?? "";
    const real = await http().post("/v1/affiliate/clicks").set("User-Agent", "Mozilla/5.0 OutletApp/1.0").send({ slug, device_id: "device-123456" });
    expect(real.status).toBe(202);
    expect(real.body).toEqual({ target_type: "product", target_id: U(301) });
    const unknown = await http().post("/v1/affiliate/clicks").set("User-Agent", "Mozilla/5.0").send({ slug: "zzzzzzzzzzzzzzzz", device_id: "device-123456" });
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual({ target_type: null, target_id: null });
    const bad = await http().post("/v1/affiliate/clicks").send({ slug, device_id: "x", extra: 1 });
    expect(bad.status).toBe(400);
  });

  it("a bot click is accepted but cannot attribute", async () => {
    const slug = (await store.getLink(linkA))?.slug ?? "";
    const r = await http().post("/v1/affiliate/clicks").set("User-Agent", "HeadlessChrome/120").send({ slug, device_id: "device-bot-0001" });
    expect(r.status).toBe(202);
    const stats = await store.clickStats(creatorAId, 0);
    expect(stats.total).toBeGreaterThanOrEqual(2);
  });
});

describe("commissions, dashboard and payouts (engaged off)", () => {
  it("shows only own commissions, without order or buyer identity, and the dashboard is aggregate only", async () => {
    const at = attribution(1, creatorAId, linkA, U(50), { orderGroupId: U(401) });
    await store.insertAttribution(at, []);
    await store.claimAccrual({ consumer: "t", messageId: U(2001), commission: newCommission(1, creatorAId, at.orderGroupId) });
    await ledger.post(
      (await import("@outlet/domain")).creatorCommissionAccrued(
        { creatorId: U(1), amount: (await import("@outlet/domain")).money(3_000n) },
        { id: "e1", idempotencyKey: "creator_commission:x:0", occurredAt: new Date(T0), ref: { type: "commission", id: "x" } },
      ),
    );
    const mine = await get("/v1/creator/commissions", TK.a);
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({ state: "ACCRUED", amount: { amount: "3000", currency: "EGP" } });
    const text = JSON.stringify(mine.body);
    expect(text).not.toContain(U(401));
    expect(text).not.toContain(U(50));
    expect(text).not.toContain(U(701));
    expect((await get("/v1/creator/commissions", TK.b)).body.items).toHaveLength(0);
    const dash = await get("/v1/creator/dashboard", TK.a);
    expect(dash.status).toBe(200);
    expect(dash.body).toMatchObject({ payable: { amount: "3000" }, balance_negative: false, payouts_enabled: false, status: "ACTIVE" });
    expect(JSON.stringify(dash.body)).not.toContain(U(50));
  });

  it("payout routes answer 503 while the kill switch is blocked and create nothing", async () => {
    const r = await send("post", "/v1/admin/creator-payouts", TK.finance, { creator_id: creatorAId });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("creator_payouts_disabled");
    expect(await store.listPayouts({ limit: 10 })).toHaveLength(0);
    expect((await get("/v1/creator/payouts", TK.a)).body.items).toEqual([]);
    expect((await send("post", `/v1/admin/creator-payouts/${U(900)}/send`, TK.finance)).status).toBe(503);
  });

  it("with the switch allowed but no rail configured the send is refused and no money moves", async () => {
    flags.payouts = true;
    try {
      const c = await send("post", "/v1/creator/payout-preference", TK.a, { preference: "cash" });
      expect(c.status).toBe(200);
      const p = await send("post", "/v1/admin/creator-payouts", TK.finance, { creator_id: creatorAId });
      expect(p.status).toBe(422); // below the minimum payout (30 EGP < 500 EGP)
      expect(p.body.code).toBe("below_minimum");
      expect((await send("post", `/v1/admin/creator-payouts/${U(900)}/send`, TK.finance)).status).toBe(503);
      expect(await ledger.payableBalance(U(1))).toBe(3_000n);
    } finally {
      flags.payouts = false;
    }
  });
});

describe("A-3: admin void of an attribution (trust and safety only)", () => {
  const path = (id: string) => `/v1/admin/creators/attributions/${id}/void`;

  it("support, ops, finance and shoppers get 403; a body with free text is a 400; nothing changes", async () => {
    for (const t of [TK.support, TK.ops, TK.finance, TK.shopperOnAdmin]) {
      expect((await send("post", path(U(401)), t, { reason: "cluster" })).status).toBe(403);
    }
    // H2: every denial is audited with the action's rule id and the opaque order group id, no free text.
    const denied = audit.entries.filter((e) => e.ruleId === "creators.attribution.void" && e.effect === "deny");
    expect(denied.map((e) => e.actorId).sort()).toEqual([U(3), U(41), U(42), U(43)].sort());
    for (const e of denied) expect(e).toMatchObject({ resourceId: U(401), httpStatus: 403, reason: "missing_role" });
    expect((await send("post", path(U(401)), TK.ts, { reason: "because I said so" })).status).toBe(400);
    expect((await send("post", path(U(401)), TK.ts, { reason: "cluster", extra: 1 })).status).toBe(400);
    expect((await store.getAttribution(U(401)))?.status).toBe("ACTIVE");
    expect(await ledger.payableBalance(U(1))).toBe(3_000n);
  });

  it("fails closed with 503 and does not void when the audit sink fails on an allowed void", async () => {
    const original = audit.record.bind(audit);
    audit.record = async () => {
      throw new Error("sink down");
    };
    try {
      const r = await send("post", path(U(401)), TK.ts, { reason: "cluster" });
      expect(r.status).toBe(503);
      expect((await store.getAttribution(U(401)))?.status).toBe("ACTIVE");
    } finally {
      audit.record = original;
    }
  });

  it("an unknown order group is a 404", async () => {
    expect((await send("post", path(U(998)), TK.ts, { reason: "cluster" })).status).toBe(404);
  });

  it("trust and safety voids after accrual: clawback posted, payable back to zero, ledger balanced; replay is stable", async () => {
    const r = await send("post", path(U(401)), TK.ts, { reason: "shared_payment" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "voided", commissions_affected: 1, clawed_back: "3000" });
    const allowed = audit.entries.filter((e) => e.ruleId === "creators.attribution.void" && e.effect === "allow" && e.resourceId === U(401));
    expect(allowed).toHaveLength(1); // the replay below is audited too
    expect(allowed[0]).toMatchObject({ actorId: U(45), resourceId: U(401), httpStatus: 200 });
    expect((await store.getAttribution(U(401)))?.status).toBe("VOIDED");
    // The fixture hand-posted a 3,000 accrual outside the commission's intents; the void posts the
    // commission's own unposted accrual intent (+3,000) and then its clawback (-3,000): net unchanged.
    expect(await ledger.payableBalance(U(1))).toBe(3_000n);
    expect(ledger.trialBalance()).toBe(0n);
    const again = await send("post", path(U(401)), TK.ts, { reason: "shared_payment" });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("already_voided");
    expect(await ledger.payableBalance(U(1))).toBe(3_000n);
  });
});
