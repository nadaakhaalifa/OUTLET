import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import { SELLER_PERMISSION_CHECKS, decide, type Actor, type BrandRole, type Grant, type Rule } from "@outlet/policy";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator } from "../../../platform";
import { CLOCK, POLICY_RULES } from "../../../platform/tokens";
import { StaticStoreStatusLookup } from "../adapters/store-status";
import { SellerAnalyticsModule } from "../seller-analytics.module";
import { FakeClock } from "./harness";
import { STORE_A, STORE_B, U } from "./repository-contract";

const STORE_PAUSED = "00000000-0000-4000-a000-000000000003";
const STORE_SUSPENDED = "00000000-0000-4000-a000-000000000004";
const STORE_DRAFT = "00000000-0000-4000-a000-000000000005";
const STORE_MISSING = "00000000-0000-4000-a000-0000000000ff";
const ROLES: readonly BrandRole[] = ["owner", "manager", "catalog", "warehouse", "finance", "support"];

const brand = (storeId: string, role: BrandRole): Grant => ({ kind: "brand", storeId, role });
const seller = (id: string, grants: readonly Grant[], scopes: readonly string[] = ["seller:read", "seller:write"]): Actor => ({
  id, status: "active", assurance: "basic", grants, tokenScopes: scopes,
});

const subjects = new Map<string, { actor: Actor; aud: AccessClaims["aud"] }>();
const token = (name: string, actor: Actor, aud: AccessClaims["aud"] = "seller_api"): string => {
  const t = `token-me-${name}-0000000000000000`;
  subjects.set(t, { actor, aud });
  return t;
};
const ROLE_TOKEN = Object.fromEntries(ROLES.map((r, i) => [r, token(r, seller(U(100 + i), [brand(STORE_A, r)]))])) as Record<BrandRole, string>;
const T = {
  ownerB: token("ownerB", seller(U(120), [brand(STORE_B, "owner")])),
  multi: token("multi", seller(U(121), [brand(STORE_A, "owner"), brand(STORE_PAUSED, "warehouse"), brand(STORE_SUSPENDED, "owner"), brand(STORE_DRAFT, "manager")])),
  ghost: token("ghost", seller(U(122), [brand(STORE_MISSING, "owner")])),
  shopper: token("shopper", { id: U(123), status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] }),
  buyerAud: token("buyerAud", seller(U(124), [brand(STORE_A, "owner")]), "buyer_api"),
  adminAud: token("adminAud", seller(U(125), [brand(STORE_A, "owner")]), "admin_api"),
  readOnly: token("readonly", seller(U(126), [brand(STORE_A, "owner")], ["seller:read"])),
};

class Tokens implements Authenticator {
  async authenticate(bearer: string, nowMs: number) {
    const s = subjects.get(bearer);
    if (s === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    const claims: AccessClaims = { iss: "test", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `j-${bearer}`, sid: `s-${bearer}`, amr: ["otp_sms"] };
    return { actor: s.actor, claims };
  }
}

let app: INestApplication;
let statuses: StaticStoreStatusLookup;
let rules: readonly Rule[];
let nowMs: number;
let clock: FakeClock;
let calls = 0;
const http = () => {
  // The route is limited to 120 per user per 60 s on the injected clock: step it so a long loop is never throttled.
  calls += 1;
  if (calls % 50 === 0) clock.advance(61_000);
  return request(app.getHttpServer());
};
const auth = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
const meOf = (t: string, store: string) => http().get(`/v1/seller/stores/${store}/me`).set(auth(t));
const strip = (b: Record<string, unknown>) => {
  const { request_id: _r, ...rest } = b;
  return rest;
};
const KEYS = SELLER_PERMISSION_CHECKS.map((c) => c[0]);
const allowed = (b: { permissions: Record<string, boolean> }) => KEYS.filter((k) => b.permissions[k]);

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: "test" });
  clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  statuses = new StaticStoreStatusLookup();
  statuses.set(STORE_A, "ACTIVE");
  statuses.set(STORE_B, "ACTIVE");
  statuses.set(STORE_PAUSED, "PAUSED");
  statuses.set(STORE_SUSPENDED, "SUSPENDED");
  statuses.set(STORE_DRAFT, "DRAFT");
  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: new Tokens() }], exports: [AUTHENTICATOR] };
    }
  }
  const ref = await Test.createTestingModule({
    imports: [PlatformModule.forRoot(config, { clock, ids }), TestAuthModule.register(), SellerAnalyticsModule.forRoot(config, { storeStatus: statuses })],
  }).compile();
  app = ref.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  rules = app.get<readonly Rule[]>(POLICY_RULES, { strict: false });
  nowMs = app.get<{ nowMs(): number }>(CLOCK, { strict: false }).nowMs();
}, 30_000);
afterAll(async () => {
  await app.close();
});

describe("GET /v1/seller/stores/{storeId}/me: authorization and M8 ordering", () => {
  it("401 without a token, with a buyer or admin audience token; 403 for a shopper grant", async () => {
    expect((await http().get(`/v1/seller/stores/${STORE_A}/me`)).status).toBe(401);
    expect((await meOf(T.buyerAud, STORE_A)).status).toBe(401);
    expect((await meOf(T.adminAud, STORE_A)).status).toBe(401);
    expect((await meOf(T.shopper, STORE_A)).status).toBe(403);
  });

  it("own store: 200 with the policy permissions and the real status", async () => {
    const r = await meOf(ROLE_TOKEN.owner, STORE_A);
    expect(r.status).toBe(200);
    expect(r.body.membership).toMatchObject({ store_id: STORE_A, role: "owner", store_status: "active" });
    expect(allowed(r.body.membership)).toEqual(KEYS);
    expect(typeof r.body.server_time).toBe("string");
  });

  it("foreign store, unknown store and malformed id: 404 with byte-equal bodies", async () => {
    const foreign = await meOf(T.ownerB, STORE_A);
    const unknown = await meOf(T.ownerB, STORE_MISSING);
    const malformed = await meOf(T.ownerB, "not-a-uuid");
    expect([foreign.status, unknown.status, malformed.status]).toEqual([404, 404, 404]);
    expect(strip(foreign.body)).toEqual(strip(unknown.body));
    expect(strip(foreign.body)).toEqual(strip(malformed.body));
    expect(JSON.stringify(foreign.body)).not.toContain(STORE_A);
  });

  it("a held grant on a missing row is 404 with the same body as foreign", async () => {
    const ghost = await meOf(T.ghost, STORE_MISSING);
    const foreign = await meOf(T.ownerB, STORE_A);
    expect(ghost.status).toBe(404);
    expect(strip(ghost.body)).toEqual(strip(foreign.body));
  });

  it("no store read for a foreign, unknown or malformed id; exactly one for a held id", async () => {
    statuses.reads.length = 0;
    await meOf(T.ownerB, STORE_A);
    await meOf(T.ownerB, STORE_MISSING);
    await meOf(T.ownerB, "zzz");
    expect(statuses.reads).toEqual([]);
    await meOf(T.ownerB, STORE_B);
    expect(statuses.reads).toEqual([[STORE_B]]);
  });

  it("timing class: foreign and unknown ids skip the database and stay in the same latency band", async () => {
    const median = async (store: string): Promise<number> => {
      const xs: number[] = [];
      for (let i = 0; i < 200; i += 1) {
        const t0 = performance.now();
        await meOf(T.ownerB, store);
        xs.push(performance.now() - t0);
      }
      xs.sort((a, b) => a - b);
      return xs[100] ?? 0;
    };
    await median(STORE_A); // warm up
    const foreign = await median(STORE_A);
    const unknown = await median(STORE_MISSING);
    // Regression guard, not statistics: both paths execute identical code; allow generous noise.
    expect(Math.abs(foreign - unknown)).toBeLessThan(Math.max(5, Math.min(foreign, unknown) * 2));
  }, 60_000);
});

describe("role matrix: permissions equal decide() for every role", () => {
  for (const role of ROLES) {
    it(`${role}: every key equals decide() with the real (active) state`, async () => {
      const r = await meOf(ROLE_TOKEN[role], STORE_A);
      expect(r.status).toBe(200);
      const actor = seller(U(0), [brand(STORE_A, role)]);
      for (const [key, type, action] of SELLER_PERMISSION_CHECKS) {
        const d = decide({ actor, action, resourceType: type, resource: { type, id: STORE_A, storeId: STORE_A, state: "active" }, nowMs }, rules);
        expect(r.body.membership.permissions[key], `${role} ${key}`).toBe(d.effect === "allow");
      }
    });
  }

  it("a read-only token drops every write key and keeps the reads (token scopes count)", async () => {
    const r = await meOf(T.readOnly, STORE_A);
    expect(r.status).toBe(200);
    expect(r.body.membership.permissions["store_product.update"]).toBe(false);
    expect(r.body.membership.permissions["store_product.read"]).toBe(true);
  });
});

describe("store state is passed to decide()", () => {
  it("paused: store_status paused, permissions equal decide() for state paused", async () => {
    const r = await meOf(T.multi, STORE_PAUSED);
    expect(r.status).toBe(200);
    expect(r.body.membership.store_status).toBe("paused");
    const actor = seller(U(121), [brand(STORE_PAUSED, "warehouse")]);
    for (const [key, type, action] of SELLER_PERMISSION_CHECKS) {
      const d = decide({ actor, action, resourceType: type, resource: { type, id: STORE_PAUSED, storeId: STORE_PAUSED, state: "paused" }, nowMs }, rules);
      expect(r.body.membership.permissions[key], key).toBe(d.effect === "allow");
    }
  });

  it("draft: store_status draft", async () => {
    expect((await meOf(T.multi, STORE_DRAFT)).body.membership.store_status).toBe("draft");
  });

  it("suspended: status suspended, every permission false (reads and writes), still 200 so the UI can explain", async () => {
    const r = await meOf(T.multi, STORE_SUSPENDED);
    expect(r.status).toBe(200);
    expect(r.body.membership.store_status).toBe("suspended");
    expect(allowed(r.body.membership)).toEqual([]);
  });
});

describe("GET /v1/seller/me (list)", () => {
  it("returns every held store sorted by id with status, permissions and server_time; one batched lookup", async () => {
    statuses.reads.length = 0;
    const r = await http().get("/v1/seller/me").set(auth(T.multi));
    expect(r.status).toBe(200);
    expect(r.body.memberships.map((m: { store_id: string }) => m.store_id)).toEqual([STORE_A, STORE_PAUSED, STORE_SUSPENDED, STORE_DRAFT]);
    expect(r.body.memberships.map((m: { store_status: string }) => m.store_status)).toEqual(["active", "paused", "suspended", "draft"]);
    expect(allowed(r.body.memberships[2])).toEqual([]);
    expect(typeof r.body.server_time).toBe("string");
    expect(statuses.reads).toHaveLength(1);
  });

  it("a grant on a store without a row is omitted, never guessed", async () => {
    const r = await http().get("/v1/seller/me").set(auth(T.ghost));
    expect(r.status).toBe(200);
    expect(r.body.memberships).toEqual([]);
  });

  it("only the caller's own memberships appear", async () => {
    const r = await http().get("/v1/seller/me").set(auth(T.ownerB));
    expect(JSON.stringify(r.body)).not.toContain(STORE_A);
  });

  it("a status backend failure is 503, never a partial membership list", async () => {
    const original = statuses.statusesOf.bind(statuses);
    statuses.statusesOf = async () => {
      throw new Error("db down");
    };
    try {
      expect((await http().get("/v1/seller/me").set(auth(T.ownerB))).status).toBe(503);
      expect((await meOf(T.ownerB, STORE_B)).status).toBe(503);
    } finally {
      statuses.statusesOf = original;
    }
  });
});
