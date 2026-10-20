import "reflect-metadata";
import { Global, Module, type DynamicModule } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor } from "@outlet/policy";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { configureApp } from "./app.setup";
import { loadConfig } from "./config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator } from "./platform";
import { InMemoryTaxDocumentRepository, FakeEtaPort, InMemorySignedDocumentStore, InMemorySigningDelegations, InMemoryTaxConfigRepository, InMemoryTaxEtaEventPublisher } from "./modules/tax-eta/adapters/in-memory";
import * as TT from "./modules/tax-eta/adapters/tokens";
import type { IssueDocument } from "./modules/tax-eta/application/tax";
import { TaxEtaModule } from "./modules/tax-eta/tax-eta.module";
import { money } from "./modules/tax-eta/domain/bridge";
import { consumerParty, haul, sellerParty } from "./modules/tax-eta/test/fixtures";
import { FakeClock, STORE_A, STORE_B, U } from "./modules/tax-eta/test/harness";
import { createAnalyticsHarness, bearer, TOKENS as AT } from "./modules/seller-analytics/test/harness";
import { STORE_A as AN_A, T0, ev, purchase, shopper, P1, SKU_M } from "./modules/seller-analytics/test/repository-contract";

async function taxApp(actor: Actor) {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens: Authenticator = {
    async authenticate(b: string, nowMs: number) {
      if (b !== "token-multi-store-seller-0001") return null;
      const iat = Math.floor(nowMs / 1000);
      const claims: AccessClaims = { iss: "t", sub: actor.id, aud: "seller_api", iat, exp: iat + 600, jti: "j1", sid: "s1", amr: ["otp_sms"] };
      return { actor, claims };
    },
  };
  @Global()
  @Module({})
  class Auth {
    static register(): DynamicModule {
      return { module: Auth, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }
  const mod = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      Auth.register(),
      TaxEtaModule.forRoot(config, {
        config: new InMemoryTaxConfigRepository(),
        documents: new InMemoryTaxDocumentRepository(),
        eta: new FakeEtaPort(),
        signed: new InMemorySignedDocumentStore(),
        delegations: new InMemorySigningDelegations(),
        events: new InMemoryTaxEtaEventPublisher(),
      }),
    ],
  }).compile();
  const app = mod.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, issue: app.get<IssueDocument>(TT.ISSUE_DOCUMENT, { strict: false }), http: () => request(app.getHttpServer()) };
}

const invoice = (issue: IssueDocument, ref: string, store: string, recipientStore = store) =>
  issue.execute({
    kind: "seller_einvoice",
    sourceRef: ref,
    issuer: haul,
    recipient: sellerParty(recipientStore),
    lines: [{ lineType: "commission", descriptionAr: "عمولة", categoryCode: "marketplace_fee", amount: money(10_000n) }],
    storeId: store,
    userId: null,
  });

describe("wave3 tax-eta adversarial", () => {
  it("DEFECT: seller list leaks invoices of a store where the caller lacks a payout-capable role (only the FIRST grant is authorised)", async () => {
    const actor: Actor = {
      id: U(77),
      status: "active",
      assurance: "basic",
      grants: [
        { kind: "brand", storeId: STORE_A, role: "owner" },
        { kind: "brand", storeId: STORE_B, role: "catalog" },
      ],
      tokenScopes: ["seller:read", "seller:write"] as Actor["tokenScopes"],
    };
    const t = await taxApp(actor);
    try {
      const a = await invoice(t.issue, "a1", STORE_A);
      const b = await invoice(t.issue, "b1", STORE_B);
      if (a.kind !== "ok" || b.kind !== "ok") throw new Error("issue");
      // Direct fetch of B's invoice is correctly refused for a catalog role...
      const one = await t.http().get(`/v1/seller/invoices/${b.value.stored.id}`).set(bearer("token-multi-store-seller-0001"));
      expect([403, 404]).toContain(one.status);
      // ...but the list returns it anyway.
      const list = await t.http().get("/v1/seller/invoices").set(bearer("token-multi-store-seller-0001"));
      expect(list.status).toBe(200);
      expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([a.value.stored.id]);
    } finally {
      await t.app.close();
    }
  });

  it("DEFECT: IssueDocument stores an e-invoice addressed to store B under store A (storeId / recipient.refId never cross-checked)", async () => {
    const t = await taxApp({ id: U(78), status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });
    try {
      const r = await invoice(t.issue, "mismatch-1", STORE_A, STORE_B);
      expect(r.kind).toBe("invalid");
    } finally {
      await t.app.close();
    }
  });

  it("DEFECT: shopper receipt may be stored against a different user than its recipient.refId", async () => {
    const t = await taxApp({ id: U(78), status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });
    try {
      const r = await t.issue.execute({
        kind: "shopper_ereceipt",
        sourceRef: "rcp-mismatch",
        issuer: haul,
        recipient: consumerParty(U(1)),
        lines: [{ lineType: "delivery_fee", descriptionAr: "توصيل", categoryCode: "shipping", amount: money(11_400n) }],
        storeId: null,
        userId: U(2),
      });
      expect(r.kind).toBe("invalid");
    } finally {
      await t.app.close();
    }
  });
});

describe("wave3 seller-analytics adversarial", () => {
  it("DEFECT: suppressed governorate is recoverable by subtracting released cells from the sales total", async () => {
    const h = await createAnalyticsHarness();
    try {
      const events = [];
      for (let i = 1; i <= 50; i += 1) events.push(purchase(i, SKU_M, P1, 1, 1_000n, { shopper: i, gov: "Cairo", store: AN_A }));
      events.push(purchase(900, SKU_M, P1, 1, 777n, { shopper: 900, gov: "Aswan", store: AN_A }));
      await h.store.ingest("t", events, T0);
      const q = `?from=${new Date(T0 - 86_400_000 * 5).toISOString()}&to=${new Date(T0).toISOString()}`;
      const base = `/v1/seller/stores/${AN_A}/analytics`;
      const geo = await h.http().get(`${base}/geography${q}`).set(bearer(AT.ownerA));
      const sales = await h.http().get(`${base}/sales${q}`).set(bearer(AT.ownerA));
      expect(geo.status).toBe(200);
      expect(geo.body.governorates.map((g: { governorate: string }) => g.governorate)).toEqual(["Cairo"]);
      const released = geo.body.governorates.reduce((n: bigint, g: { gmv: { amount_minor: string } }) => n + BigInt(g.gmv.amount_minor), 0n);
      const derived = BigInt(sales.body.gmv.amount_minor) - released;
      expect(derived).not.toBe(777n); // differencing isolates the single suppressed shopper's spend
    } finally {
      await h.close();
    }
  });

  it("DEFECT: suppressed traffic source is recoverable from totals minus released cells", async () => {
    const h = await createAnalyticsHarness();
    try {
      const events = [];
      for (let i = 1; i <= 50; i += 1) events.push(ev({ kind: "store_view", source: "feed" }, { shopper: i, at: T0 - 1000 }));
      for (let n = 0; n < 3; n += 1) events.push(ev({ kind: "store_view", source: "creator" }, { shopper: 901, at: T0 - 1000 }));
      await h.store.ingest("t", events, T0);
      const q = `?from=${new Date(T0 - 86_400_000).toISOString()}&to=${new Date(T0).toISOString()}`;
      const r = await h.http().get(`/v1/seller/stores/${AN_A}/analytics/traffic${q}`).set(bearer(AT.ownerA));
      expect(r.status).toBe(200);
      const released = r.body.by_source.items.reduce((n: number, i: { events: number }) => n + i.events, 0);
      expect(r.body.store_views + r.body.product_views - released).not.toBe(3);
      void shopper;
    } finally {
      await h.close();
    }
  });
});
