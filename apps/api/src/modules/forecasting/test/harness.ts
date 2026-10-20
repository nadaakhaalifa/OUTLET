import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, BrandRole } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator, type Clock } from "../../../platform";
import { InMemoryForecastStore, StaticForecastFlags } from "../adapters/in-memory";
import * as T from "../adapters/tokens";
import type { IngestDemandSeries, RunForecastBatch } from "../application/forecasting";
import { ForecastingModule } from "../forecasting.module";
import { NOW_MS, U } from "./fixtures";

export class FakeClock implements Clock {
  constructor(private ms = NOW_MS) {}
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
  ownerA: "token-fc-owner-a-00000000001",
  managerA: "token-fc-manager-a-000000002",
  warehouseA: "token-fc-warehouse-a-0000003",
  catalogA: "token-fc-catalog-a-000000004",
  financeA: "token-fc-finance-a-000000005",
  supportA: "token-fc-support-a-000000006",
  ownerB: "token-fc-owner-b-00000000007",
  suspendedA: "token-fc-suspended-a-0000008",
  noScopeA: "token-fc-noscope-a-00000009",
  shopper: "token-fc-shopper-0000000010",
  buyerAudSeller: "token-fc-buyer-aud-0000000011",
};

export interface ForecastHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly store: InMemoryForecastStore;
  readonly flags: StaticForecastFlags;
  readonly ingest: IngestDemandSeries;
  readonly batch: RunForecastBatch;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createForecastHarness(): Promise<ForecastHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  const A = "00000000-0000-4000-a000-000000000001";
  const B = "00000000-0000-4000-a000-000000000002";
  tokens.add(TOKENS.ownerA, { actor: sellerActor(U(11), A, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.managerA, { actor: sellerActor(U(12), A, "manager"), aud: "seller_api" });
  tokens.add(TOKENS.warehouseA, { actor: sellerActor(U(13), A, "warehouse"), aud: "seller_api" });
  tokens.add(TOKENS.catalogA, { actor: sellerActor(U(14), A, "catalog"), aud: "seller_api" });
  tokens.add(TOKENS.financeA, { actor: sellerActor(U(15), A, "finance"), aud: "seller_api" });
  tokens.add(TOKENS.supportA, { actor: sellerActor(U(16), A, "support"), aud: "seller_api" });
  tokens.add(TOKENS.ownerB, { actor: sellerActor(U(17), B, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.suspendedA, { actor: sellerActor(U(18), A, "owner", { status: "suspended" }), aud: "seller_api" });
  tokens.add(TOKENS.noScopeA, { actor: sellerActor(U(19), A, "owner", { tokenScopes: [] }), aud: "seller_api" });
  tokens.add(TOKENS.shopper, { actor: shopperActor(U(1)), aud: "seller_api" });
  tokens.add(TOKENS.buyerAudSeller, { actor: sellerActor(U(11), A, "owner"), aud: "buyer_api" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const store = new InMemoryForecastStore();
  const flags = new StaticForecastFlags(true);
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      ForecastingModule.forRoot(config, { store, flags }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return {
    app,
    clock,
    store,
    flags,
    ingest: app.get<IngestDemandSeries>(T.FORECAST_INGEST, { strict: false }),
    batch: app.get<RunForecastBatch>(T.FORECAST_BATCH, { strict: false }),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
