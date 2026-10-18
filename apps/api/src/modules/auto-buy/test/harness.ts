import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator } from "../../../platform";
import { AutoBuyModule } from "../auto-buy.module";
import { createWorld, type World } from "./world";

export const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
export const UU = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Subject {
  readonly actor: Actor;
  readonly aud: AccessClaims["aud"];
}

export class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, Subject>();
  add(token: string, subject: Subject): string {
    this.subjects.set(token, subject);
    return token;
  }
  async authenticate(bearer: string, nowMs: number) {
    const s = this.subjects.get(bearer);
    if (s === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    const claims: AccessClaims = { iss: "test", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `jti-${bearer}`, sid: `sid-${bearer}`, amr: ["otp_sms"] };
    return { actor: s.actor, claims };
  }
}

export const TOKENS = {
  /** Shopper A with a passkey session (step-up satisfied). */
  a: "token-shopper-a-000000000000001",
  /** Shopper B with a passkey session. */
  b: "token-shopper-b-000000000000002",
  /** Shopper A on an OTP-only session. */
  aBasic: "token-shopper-a-basic-0000000006",
  seller: "token-seller-owner-0000000000003",
  admin: "token-admin-support-000000000004",
  shopperOnSellerAud: "token-shopper-on-seller-aud-05",
  ops: "token-admin-ops-000000000000000006",
  finance: "token-admin-finance-00000000000007",
  opsBasic: "token-admin-ops-basic-000000000008",
  adminOnBuyerAud: "token-admin-on-buyer-aud-000000009",
};

const shopper = (id: string, assurance: "basic" | "passkey"): Actor => ({ id, status: "active", assurance, grants: [{ kind: "shopper" }], tokenScopes: [] });

export interface AutoBuyHarness {
  readonly app: INestApplication;
  readonly world: World;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createAutoBuyHarness(): Promise<AutoBuyHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const world = createWorld();
  const ids = createIdGenerator(world.clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.a, { actor: shopper(UU(1), "passkey"), aud: "buyer_api" });
  tokens.add(TOKENS.b, { actor: shopper(UU(2), "passkey"), aud: "buyer_api" });
  tokens.add(TOKENS.aBasic, { actor: shopper(UU(1), "basic"), aud: "buyer_api" });
  tokens.add(TOKENS.seller, {
    actor: { id: UU(11), status: "active", assurance: "basic", grants: [{ kind: "brand", storeId: UU(9001), role: "owner" }], tokenScopes: ["seller:read", "seller:write"] },
    aud: "seller_api",
  });
  tokens.add(TOKENS.admin, {
    actor: { id: UU(21), status: "active", assurance: "passkey", grants: [{ kind: "admin", role: "support" }], tokenScopes: ["admin:access"] },
    aud: "admin_api",
  });
  tokens.add(TOKENS.shopperOnSellerAud, { actor: shopper(UU(1), "passkey"), aud: "seller_api" });
  const admin = (id: number, role: "ops" | "finance", assurance: "basic" | "passkey"): Actor => ({
    id: UU(id),
    status: "active",
    assurance,
    grants: [{ kind: "admin", role }],
    tokenScopes: ["admin:access"],
  });
  tokens.add(TOKENS.ops, { actor: admin(31, "ops", "passkey"), aud: "admin_api" });
  tokens.add(TOKENS.finance, { actor: admin(32, "finance", "passkey"), aud: "admin_api" });
  tokens.add(TOKENS.opsBasic, { actor: admin(33, "ops", "basic"), aud: "admin_api" });
  tokens.add(TOKENS.adminOnBuyerAud, { actor: admin(34, "ops", "passkey"), aud: "buyer_api" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock: world.clock, ids }),
      TestAuthModule.register(),
      AutoBuyModule.forRoot(config, {
        store: world.store,
        flags: world.flags,
        eligibility: world.eligibility,
        catalog: world.catalog,
        deliverability: world.deliverability,
        risk: world.risk,
        budget: world.budget,
        vault: world.vault,
        inventory: world.inventory,
        mit: world.mit,
        notices: world.notices,
        opsAudit: world.opsAudit,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, world, http: () => request(app.getHttpServer()), close: () => app.close() };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
