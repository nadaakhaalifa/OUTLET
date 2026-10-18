import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator } from "../../../platform";
import { BrandVerificationModule } from "../brand-verification.module";
import {
  FakeApplicationOwnership, FakeDnsResolver, FakeSanctionsScreening, FakeVerificationEmail, FixtureTrademarkRegistry,
  InMemoryBrandVerificationStore, StaticVerificationSecret,
} from "../adapters/in-memory";
import { FakeClock, U, snapshot } from "./fixtures";

export const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
export const APP_A = snapshot(1);
export const APP_B = snapshot(2, { websiteDomain: "other-brand.com", trademark: null, brandName: "Other Brand" });
export const TOKENS = {
  sellerA: "token-seller-a-000000000000000001",
  sellerB: "token-seller-b-000000000000000002",
  sellerNoScope: "token-seller-noscope-0000000003",
  shopper: "token-shopper-0000000000000000004",
  ops: "token-admin-ops-00000000000000005",
  trust: "token-admin-trust-0000000000000006",
  support: "token-admin-support-0000000000007",
  opsBasic: "token-admin-ops-basic-0000000008",
  suspendedSeller: "token-seller-suspended-00000009",
};

class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, { actor: Actor; aud: AccessClaims["aud"] }>();
  add(token: string, actor: Actor, aud: AccessClaims["aud"]): void {
    this.subjects.set(token, { actor, aud });
  }
  async authenticate(bearer: string, nowMs: number) {
    const s = this.subjects.get(bearer);
    if (s === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    return { actor: s.actor, claims: { iss: "test", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `jti-${bearer}`, sid: `sid-${bearer}`, amr: ["otp_sms"] } as AccessClaims };
  }
}

const seller = (id: string, scopes: string[], status: Actor["status"] = "active"): Actor => ({ id, status, assurance: "basic", grants: [], tokenScopes: scopes });
const admin = (id: string, role: "ops" | "trust_safety" | "support", assurance: Actor["assurance"] = "passkey"): Actor => ({
  id, status: "active", assurance, grants: [{ kind: "admin", role }], tokenScopes: ["admin:access"],
});

export async function createHarness() {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const store = new InMemoryBrandVerificationStore();
  const ownership = new FakeApplicationOwnership();
  ownership.seed(APP_A);
  ownership.seed(APP_B);
  const dns = new FakeDnsResolver();
  const registry = new FixtureTrademarkRegistry();
  const email = new FakeVerificationEmail();
  const tokens = new TokenTable();
  tokens.add(TOKENS.sellerA, seller(APP_A.applicantId, ["seller:enrol"]), "seller_api");
  tokens.add(TOKENS.sellerB, seller(APP_B.applicantId, ["seller:kyc.write"]), "seller_api");
  tokens.add(TOKENS.sellerNoScope, seller(APP_A.applicantId, ["seller:read"]), "seller_api");
  tokens.add(TOKENS.suspendedSeller, seller(APP_A.applicantId, ["seller:enrol"], "suspended"), "seller_api");
  tokens.add(TOKENS.shopper, { id: U(1), status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] }, "buyer_api");
  tokens.add(TOKENS.ops, admin(U(21), "ops"), "admin_api");
  tokens.add(TOKENS.trust, admin(U(22), "trust_safety"), "admin_api");
  tokens.add(TOKENS.support, admin(U(23), "support"), "admin_api");
  tokens.add(TOKENS.opsBasic, admin(U(24), "ops", "basic"), "admin_api");

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids: createIdGenerator(clock, nodeCsprng) }),
      TestAuthModule.register(),
      BrandVerificationModule.forRoot(config, { store, ownership, dns, registry, sanctions: new FakeSanctionsScreening(), email, secret: new StaticVerificationSecret() }),
    ],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, store, ownership, dns, registry, email, clock, http: () => request(app.getHttpServer()), close: () => app.close() };
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;
export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
