import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, BrandRole } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator, type Clock } from "../../../platform";
import { StaticStoreStatusLookup } from "../adapters/store-status";
import { InMemoryAnalyticsStore, InMemoryAudit, InMemoryEventSource, StaticProductStoreLookup } from "../adapters/in-memory";
import * as T from "../adapters/tokens";
import type { ConsumeSellerAnalytics } from "../application/consume";
import { SellerAnalyticsModule, type SellerAnalyticsModuleOverrides } from "../seller-analytics.module";
import { STORE_A, STORE_B, T0, U } from "./repository-contract";

export class FakeClock implements Clock {
  constructor(private ms = T0) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

interface Subject {
  readonly actor: Actor;
  readonly aud: AccessClaims["aud"];
}

class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, Subject>();
  add(token: string, subject: Subject): void {
    this.subjects.set(token, subject);
  }
  async authenticate(bearer: string, nowMs: number) {
    const s = this.subjects.get(bearer);
    if (s === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    const claims: AccessClaims = {
      iss: "test", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `jti-${bearer}`, sid: `sid-${bearer}`, amr: ["otp_sms"],
    };
    return { actor: s.actor, claims };
  }
}

const shopperActor = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });
const sellerActor = (id: string, storeId: string, role: BrandRole, o: Partial<Pick<Actor, "status" | "tokenScopes">> = {}): Actor => ({
  id,
  status: o.status ?? "active",
  assurance: "basic",
  grants: [{ kind: "brand", storeId, role }],
  tokenScopes: o.tokenScopes ?? ["seller:read", "seller:write"],
});

export const TOKENS = {
  ownerA: "token-an-owner-a-00000000001",
  managerA: "token-an-manager-a-000000002",
  financeA: "token-an-finance-a-000000003",
  catalogA: "token-an-catalog-a-000000004",
  ownerB: "token-an-owner-b-00000000005",
  suspendedA: "token-an-suspended-a-0000006",
  noScopeA: "token-an-noscope-a-00000007",
  shopper: "token-an-shopper-0000000008",
  buyerAudSeller: "token-an-buyer-aud-0000000009",
};
export const OWNER_A_ID = U(11);

export interface AnalyticsHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly store: InMemoryAnalyticsStore;
  readonly audit: InMemoryAudit;
  readonly source: InMemoryEventSource;
  readonly lookup: StaticProductStoreLookup;
  readonly storeStatus: StaticStoreStatusLookup;
  readonly consumer: ConsumeSellerAnalytics;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createAnalyticsHarness(series: SellerAnalyticsModuleOverrides["series"] = {}, dashboard: SellerAnalyticsModuleOverrides["dashboard"] = {}): Promise<AnalyticsHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.ownerA, { actor: sellerActor(OWNER_A_ID, STORE_A, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.managerA, { actor: sellerActor(U(12), STORE_A, "manager"), aud: "seller_api" });
  tokens.add(TOKENS.financeA, { actor: sellerActor(U(13), STORE_A, "finance"), aud: "seller_api" });
  tokens.add(TOKENS.catalogA, { actor: sellerActor(U(14), STORE_A, "catalog"), aud: "seller_api" });
  tokens.add(TOKENS.ownerB, { actor: sellerActor(U(15), STORE_B, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.suspendedA, { actor: sellerActor(U(16), STORE_A, "owner", { status: "suspended" }), aud: "seller_api" });
  tokens.add(TOKENS.noScopeA, { actor: sellerActor(U(17), STORE_A, "owner", { tokenScopes: [] }), aud: "seller_api" });
  tokens.add(TOKENS.shopper, { actor: shopperActor(U(1)), aud: "seller_api" });
  tokens.add(TOKENS.buyerAudSeller, { actor: sellerActor(OWNER_A_ID, STORE_A, "owner"), aud: "buyer_api" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const store = new InMemoryAnalyticsStore();
  const audit = new InMemoryAudit();
  const source = new InMemoryEventSource();
  const lookup = new StaticProductStoreLookup();
  const storeStatus = new StaticStoreStatusLookup();
  storeStatus.set(STORE_A, "ACTIVE");
  storeStatus.set(STORE_B, "ACTIVE");
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      SellerAnalyticsModule.forRoot(config, { store, audit, source, productStore: lookup, storeStatus, series, dashboard }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return {
    app,
    clock,
    store,
    audit,
    source,
    lookup,
    storeStatus,
    consumer: app.get<ConsumeSellerAnalytics>(T.SELLER_ANALYTICS_CONSUMER, { strict: false }),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
