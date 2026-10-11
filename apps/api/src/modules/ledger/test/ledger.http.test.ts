import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, Grant } from "@outlet/policy";
import { sha256Hex } from "@outlet/idempotency";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import {
  AUDIT_SINK,
  AUTHENTICATOR,
  PlatformModule,
  createIdGenerator,
  nodeCsprng,
  type Authenticator,
  type InMemoryAuditSink,
} from "../../../platform";
import { InMemoryLedger, InMemoryProjection, type InMemoryLedgerTx } from "../adapters/in-memory";
import { PostingService } from "../application/posting-service";
import { LedgerModule } from "../ledger.module";
import { orderCmd } from "./contract";

const NOW = 1_800_000_000_000;
const clock = { nowMs: () => NOW };
const uid = (n: number) => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
type Aud = AccessClaims["aud"];
const principal = (n: number, token: string, grants: Grant[], aud: Aud = "admin_api", assurance: Actor["assurance"] = "passkey") => ({
  token,
  aud,
  actor: { id: uid(n), status: "active", assurance, grants, tokenScopes: [] } satisfies Actor,
});
const P = {
  finance: principal(1, "tok-finance-000000001", [{ kind: "admin", role: "finance" }]),
  ops: principal(2, "tok-ops-0000000000001", [{ kind: "admin", role: "ops" }]),
  superAdmin: principal(3, "tok-super-00000000001", [{ kind: "admin", role: "super_admin" }]),
  financeNoPasskey: principal(4, "tok-finance-nopk-000001", [{ kind: "admin", role: "finance" }], "admin_api", "basic"),
  financeExpired: principal(5, "tok-finance-expired-001", [{ kind: "admin", role: "finance", expiresAtMs: 1 }]),
  shopper: principal(6, "tok-shopper-00000000001", [{ kind: "shopper" }], "buyer_api"),
  seller: principal(7, "tok-seller-000000000001", [{ kind: "brand", storeId: uid(900), role: "manager" }], "seller_api"),
  shopperOnAdminAud: principal(8, "tok-shopper-adminaud-01", [{ kind: "shopper" }]),
};

class Auth implements Authenticator {
  private readonly all = new Map(Object.values(P).map((p) => [p.token, p]));
  async authenticate(token: string, nowMs: number) {
    const p = this.all.get(token);
    if (p === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    const claims: AccessClaims = {
      iss: "test", sub: p.actor.id, aud: p.aud, iat, exp: iat + 600, jti: `j-${p.token}`, sid: `s-${p.token}`, amr: ["otp_sms"],
    };
    return { actor: p.actor, claims };
  }
}

let app: INestApplication;
let ledger: InMemoryLedger;
let entryId: string;
let sink: InMemoryAuditSink;

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: "test" });
  const ids = createIdGenerator(clock, nodeCsprng);
  ledger = new InMemoryLedger();
  @Global()
  @Module({})
  class TestAuth {
    static register(): DynamicModule {
      return { module: TestAuth, providers: [{ provide: AUTHENTICATOR, useValue: new Auth() }], exports: [AUTHENTICATOR] };
    }
  }
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuth.register(),
      LedgerModule.forRoot(config, { store: ledger as never, reads: ledger, snapshots: ledger, projection: new InMemoryProjection() }),
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  sink = app.get<InMemoryAuditSink>(AUDIT_SINK, { strict: false });
  const svc = new PostingService<InMemoryLedgerTx>({
    store: ledger,
    clock,
    ids,
    sha256: sha256Hex,
    flags: { giftCardSalesEnabled: () => false },
  });
  const out = await ledger.run((tx) => svc.postCommand(tx, orderCmd("og_http")));
  entryId = out.stored.entry.id;
});
afterAll(async () => {
  await app.close();
});

const get = (path: string, who: { token: string } | null) => {
  const r = request(app.getHttpServer()).get(path);
  return who === null ? r : r.set("Authorization", `Bearer ${who.token}`);
};
const routes = () => [
  { name: "GET balances", path: "/v1/admin/ledger/balances" },
  { name: "GET entry", path: `/v1/admin/ledger/entries/${entryId}` },
];

describe("ledger read API authorization", () => {
  it("finance with a passkey reads balances and an entry; amounts are strings", async () => {
    const b = await get("/v1/admin/ledger/balances?type=seller_payable", P.finance);
    expect(b.status).toBe(200);
    expect(b.body.items.length).toBeGreaterThan(0);
    expect(typeof b.body.items[0].raw).toBe("string");
    const e = await get(`/v1/admin/ledger/entries/${entryId}`, P.finance);
    expect(e.status).toBe(200);
    expect(e.body.id).toBe(entryId);
    expect(e.body.chain.entry_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.body.postings.every((p: { amount: unknown }) => typeof p.amount === "string")).toBe(true);
  });

  for (const r of ["GET balances", "GET entry"]) {
    it(`${r}: no token 401, wrong audience 401, no finance role 403, no passkey 403, expired grant 403, standing super_admin 403`, async () => {
      const path = routes().find((x) => x.name === r)?.path ?? "";
      expect((await get(path, null)).status).toBe(401);
      expect((await get(path, P.shopper)).status).toBe(401);
      expect((await get(path, P.seller)).status).toBe(401);
      expect((await get(path, P.shopperOnAdminAud)).status).toBe(403);
      expect((await get(path, P.ops)).status).toBe(403);
      expect((await get(path, P.superAdmin)).status).toBe(403);
      const nopk = await get(path, P.financeNoPasskey);
      expect(nopk.status).toBe(403);
      expect(nopk.body.code).toBe("passkey_required");
      expect((await get(path, P.financeExpired)).status).toBe(403);
    });
  }

  it("unknown entry is 404 for finance; malformed id is 400-class, not a database error", async () => {
    expect((await get(`/v1/admin/ledger/entries/${uid(999)}`, P.finance)).status).toBe(404);
    expect((await get("/v1/admin/ledger/entries/not-a-uuid", P.finance)).status).toBe(400);
    expect((await get("/v1/admin/ledger/balances?limit=5000", P.finance)).status).toBe(400);
    expect((await get("/v1/admin/ledger/balances?bogus=1", P.finance)).status).toBe(400);
  });

  it("there is no write route", async () => {
    const r = await request(app.getHttpServer())
      .post("/v1/admin/ledger/entries")
      .set("Authorization", `Bearer ${P.finance.token}`)
      .send({});
    expect([404, 405]).toContain(r.status);
  });

  it("allow and deny decisions are audited", () => {
    expect(sink.entries.some((e) => e.ruleId === "ledger.balances" && e.effect === "allow")).toBe(true);
    expect(sink.entries.some((e) => e.ruleId === "ledger.entry" && e.effect === "deny" && e.reason === "missing_role")).toBe(true);
  });
});
