import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, BrandRole } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator } from "../../../platform";
import { ChannelOdooModule } from "../channel-odoo.module";
import {
  FakeOdooDns,
  FakeOdooServer,
  InMemoryChannelDirectory,
  InMemoryOdooStore,
  InMemorySkuResolver,
  ManualClock,
  RecordingPriceSink,
  RecordingStockSink,
  StaticOdooFlags,
  StaticSecrets,
} from "../index";
import { API_KEY, KMS_REF, LOGIN, STORE_A, STORE_B, TARGET_A, TOKEN_REF } from "./harness";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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
    const claims: AccessClaims = { iss: "test", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `jti-${bearer}`, sid: `sid-${bearer}`, amr: ["otp_sms"] };
    return { actor: s.actor, claims };
  }
}
const sellerActor = (id: string, storeId: string, role: BrandRole): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "brand", storeId, role }],
  tokenScopes: ["seller:read", "seller:write"],
});

export const TOKENS = {
  ownerA: "token-odoo-owner-a-0000000001",
  managerA: "token-odoo-manager-a-00000002",
  catalogA: "token-odoo-catalog-a-00000003",
  ownerB: "token-odoo-owner-b-0000000004",
  shopper: "token-odoo-shopper-000000005",
  ownerOnBuyerAud: "token-odoo-owner-buyer-aud-06",
};
export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

export async function createOdooHttpHarness() {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new ManualClock();
  const ids = createIdGenerator({ nowMs: () => clock.nowMs() }, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.ownerA, { actor: sellerActor(U(11), STORE_A, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.managerA, { actor: sellerActor(U(12), STORE_A, "manager"), aud: "seller_api" });
  tokens.add(TOKENS.catalogA, { actor: sellerActor(U(14), STORE_A, "catalog"), aud: "seller_api" });
  tokens.add(TOKENS.ownerB, { actor: sellerActor(U(17), STORE_B, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.shopper, { actor: { id: U(1), status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] }, aud: "seller_api" });
  tokens.add(TOKENS.ownerOnBuyerAud, { actor: sellerActor(U(11), STORE_A, "owner"), aud: "buyer_api" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const server = new FakeOdooServer();
  server.account = { login: LOGIN, apiKey: API_KEY };
  server.secrets.set(TOKEN_REF, { login: LOGIN, apiKey: API_KEY });
  const directory = new InMemoryChannelDirectory();
  directory.addTarget(STORE_A, TARGET_A, "odoo.shop-a.com");
  const secrets = new StaticSecrets();
  secrets.refs.add(TOKEN_REF);
  const dns = new FakeOdooDns();
  dns.set("odoo.shop-a.com", ["93.184.216.34"]);
  const flags = new StaticOdooFlags(true);
  const store = new InMemoryOdooStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      ChannelOdooModule.forRoot(config, {
        store,
        directory,
        secrets,
        flags,
        egress: server,
        dns,
        skus: new InMemorySkuResolver(),
        stock: new RecordingStockSink(),
        prices: new RecordingPriceSink(),
        sleeper: clock,
      }),
    ],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, clock, server, directory, secrets, flags, store, http: () => request(app.getHttpServer()), close: () => app.close() };
}
export type OdooHttpHarness = Awaited<ReturnType<typeof createOdooHttpHarness>>;
export { KMS_REF };
