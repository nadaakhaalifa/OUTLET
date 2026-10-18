import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, AdminRole, BrandRole } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator } from "../../../platform";
import { FakeResaleConsent, FakeResaleLedger, FakeReturnFacts, InMemoryResaleStore } from "../adapters/in-memory";
import { ResaleLaneModule } from "../resale-lane.module";
import { FakeClock, HUB_1, HUB_2, STORE_A, STORE_B, U } from "./fixtures";

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
const operator = (id: string, hubId: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "courier", hubId }], tokenScopes: [] });
const admin = (id: string, role: AdminRole): Actor => ({ id, status: "active", assurance: "passkey", grants: [{ kind: "admin", role }], tokenScopes: ["admin:access"] });

export const TOKENS = {
  opHub1: "token-rs-operator-1-000000001",
  opHub2: "token-rs-operator-2-000000002",
  adminOps: "token-rs-admin-ops-000000000011",
  adminSupport: "token-rs-admin-support-00003",
  shopper: "token-rs-shopper-0000000000004",
  ownerA: "token-rs-owner-a-0000000000005",
  catalogA: "token-rs-catalog-a-00000000006",
  supportA: "token-rs-support-a-00000000007",
  ownerB: "token-rs-owner-b-0000000000008",
  operatorOnBuyerAud: "token-rs-operator-buyer-aud-9",
  shopperOnAdminAud: "token-rs-shopper-admin-aud-10",
};
export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

export interface ResaleHarness {
  readonly app: INestApplication;
  readonly store: InMemoryResaleStore;
  readonly returns: FakeReturnFacts;
  readonly consent: FakeResaleConsent;
  readonly ledger: FakeResaleLedger;
  readonly clock: FakeClock;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createResaleHarness(): Promise<ResaleHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.opHub1, { actor: operator(U(11), HUB_1), aud: "admin_api" });
  tokens.add(TOKENS.opHub2, { actor: operator(U(12), HUB_2), aud: "admin_api" });
  tokens.add(TOKENS.adminOps, { actor: admin(U(22), "ops"), aud: "admin_api" });
  tokens.add(TOKENS.adminSupport, { actor: admin(U(21), "support"), aud: "admin_api" });
  tokens.add(TOKENS.shopper, { actor: shopper(U(31)), aud: "buyer_api" });
  tokens.add(TOKENS.ownerA, { actor: seller(U(41), STORE_A, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.catalogA, { actor: seller(U(42), STORE_A, "catalog"), aud: "seller_api" });
  tokens.add(TOKENS.supportA, { actor: seller(U(43), STORE_A, "support"), aud: "seller_api" });
  tokens.add(TOKENS.ownerB, { actor: seller(U(44), STORE_B, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.operatorOnBuyerAud, { actor: operator(U(11), HUB_1), aud: "buyer_api" });
  tokens.add(TOKENS.shopperOnAdminAud, { actor: shopper(U(31)), aud: "admin_api" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }
  const store = new InMemoryResaleStore();
  const returns = new FakeReturnFacts();
  const consent = new FakeResaleConsent();
  const ledger = new FakeResaleLedger();
  const moduleRef = await Test.createTestingModule({
    imports: [PlatformModule.forRoot(config, { clock, ids }), TestAuthModule.register(), ResaleLaneModule.forRoot(config, { store, returns, consent, ledger })],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, store, returns, consent, ledger, clock, http: () => request(app.getHttpServer()), close: () => app.close() };
}
