import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, AdminRole, BrandRole } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator } from "../../../platform";
import { FakeDomainVerifier, FakeTokenVault, InMemoryCrawlStore } from "../adapters/in-memory";
import type { ParityWarning } from "../domain/ports";
import { PriceCrawlerModule } from "../price-crawler.module";
import { FakeClock, STORE_A, STORE_B, U } from "./fixtures";

class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, { actor: Actor; aud: AccessClaims["aud"] }>();
  add(token: string, subject: { actor: Actor; aud: AccessClaims["aud"] }): void {
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

const seller = (id: string, storeId: string, role: BrandRole): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "brand", storeId, role }],
  tokenScopes: ["seller:read", "seller:write"],
});
const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });
const admin = (id: string, role: AdminRole): Actor => ({
  id,
  status: "active",
  assurance: "passkey",
  grants: [{ kind: "admin", role }],
  tokenScopes: ["admin:access"],
});

export const TOKENS = {
  ownerA: "token-cr-owner-a-0000000001",
  managerA: "token-cr-manager-a-00000002",
  catalogA: "token-cr-catalog-a-00000003",
  ownerB: "token-cr-owner-b-0000000004",
  shopper: "token-cr-shopper-000000000005",
  shopperOnSellerAud: "token-cr-shopper-seller-aud-06",
  ownerOnBuyerAud: "token-cr-owner-buyer-aud-0007",
  opsAdmin: "token-cr-admin-ops-000000008",
  supportAdmin: "token-cr-admin-support-009",
};
export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

export interface CrawlHarness {
  readonly app: INestApplication;
  readonly store: InMemoryCrawlStore;
  readonly verifier: FakeDomainVerifier;
  readonly vault: FakeTokenVault;
  readonly clock: FakeClock;
  readonly parity: { items: ParityWarning[] };
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createCrawlHarness(): Promise<CrawlHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.ownerA, { actor: seller(U(11), STORE_A, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.managerA, { actor: seller(U(12), STORE_A, "manager"), aud: "seller_api" });
  tokens.add(TOKENS.catalogA, { actor: seller(U(13), STORE_A, "catalog"), aud: "seller_api" });
  tokens.add(TOKENS.ownerB, { actor: seller(U(14), STORE_B, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.shopper, { actor: shopper(U(15)), aud: "buyer_api" });
  tokens.add(TOKENS.shopperOnSellerAud, { actor: shopper(U(15)), aud: "seller_api" });
  tokens.add(TOKENS.ownerOnBuyerAud, { actor: seller(U(11), STORE_A, "owner"), aud: "buyer_api" });
  tokens.add(TOKENS.opsAdmin, { actor: admin(U(21), "ops"), aud: "admin_api" });
  tokens.add(TOKENS.supportAdmin, { actor: admin(U(22), "support"), aud: "admin_api" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }
  const store = new InMemoryCrawlStore();
  const verifier = new FakeDomainVerifier();
  const vault = new FakeTokenVault();
  const parity = { items: [] as ParityWarning[] };
  const moduleRef = await Test.createTestingModule({
    imports: [PlatformModule.forRoot(config, { clock, ids }), TestAuthModule.register(), PriceCrawlerModule.forRoot(config, { store, verifier, vault, parity: { openFor: async () => parity.items } })],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, store, verifier, vault, clock, parity, http: () => request(app.getHttpServer()), close: () => app.close() };
}
