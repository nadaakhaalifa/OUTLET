import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Actor, Grant } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig, type AppConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator, type Clock } from "../../../platform";
import { CatalogModule } from "../catalog.module";
import { createCatalogDevFixtures, type CatalogDevFixtures } from "../adapters/in-memory";

export const START_MS = 1_800_000_000_000;

export class TestClock implements Clock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

type Aud = "buyer_api" | "seller_api" | "admin_api";

export interface TestPrincipal {
  readonly token: string;
  readonly actor: Actor;
  readonly aud: Aud;
}

const uid = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
export const STORE_A = uid(9001);
export const STORE_B = uid(9002);

function seller(n: number, token: string, grants: Grant[], extra: Partial<Actor> = {}): TestPrincipal {
  return {
    token,
    aud: "seller_api",
    actor: { id: uid(n), status: "active", assurance: "basic", grants, tokenScopes: ["seller:read", "seller:write"], ...extra },
  };
}

export const PRINCIPALS = {
  buyer: {
    token: "buyer-token-0000000001",
    aud: "buyer_api",
    actor: { id: uid(1), status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] },
  } satisfies TestPrincipal,
  buyerSuspended: {
    token: "buyer-token-0000000002",
    aud: "buyer_api",
    actor: { id: uid(2), status: "suspended", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] },
  } satisfies TestPrincipal,
  ownerA: seller(11, "seller-token-owner-a-01", [{ kind: "brand", storeId: STORE_A, role: "owner" }]),
  catalogA: seller(12, "seller-token-catalog-a1", [{ kind: "brand", storeId: STORE_A, role: "catalog" }]),
  supportA: seller(13, "seller-token-support-a1", [{ kind: "brand", storeId: STORE_A, role: "support" }]),
  warehouseA: seller(14, "seller-token-wareh-a-01", [{ kind: "brand", storeId: STORE_A, role: "warehouse" }]),
  ownerB: seller(21, "seller-token-owner-b-01", [{ kind: "brand", storeId: STORE_B, role: "owner" }]),
  multi: seller(31, "seller-token-multi-0001", [
    { kind: "brand", storeId: STORE_A, role: "owner" },
    { kind: "brand", storeId: STORE_B, role: "owner" },
  ]),
  noGrants: seller(41, "seller-token-nogrant-01", []),
  sellerSuspended: seller(51, "seller-token-suspend-01", [{ kind: "brand", storeId: STORE_A, role: "owner" }], { status: "suspended" }),
  /** Owner of store A holding a read-only token. */
  readOnlyScopeA: seller(61, "seller-token-readonly-01", [{ kind: "brand", storeId: STORE_A, role: "owner" }], { tokenScopes: ["seller:read"] }),
} as const;

class TestAuthenticator implements Authenticator {
  private readonly byToken = new Map<string, TestPrincipal>(Object.values(PRINCIPALS).map((p) => [p.token, p]));
  async authenticate(token: string, nowMs: number) {
    const p = this.byToken.get(token);
    if (p === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    return {
      actor: p.actor,
      claims: { iss: "test", sub: p.actor.id, aud: p.aud, iat, exp: iat + 600, jti: `jti-${p.actor.id}`, sid: `sid-${p.actor.id}`, amr: ["otp_sms" as const] },
    };
  }
}

@Global()
@Module({})
class TestAuthModule {
  static register(): DynamicModule {
    return {
      module: TestAuthModule,
      providers: [{ provide: AUTHENTICATOR, useValue: new TestAuthenticator() }],
      exports: [AUTHENTICATOR],
    };
  }
}

export interface CatalogHarness {
  readonly app: INestApplication;
  readonly clock: TestClock;
  readonly fixtures: CatalogDevFixtures;
  readonly config: AppConfig;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createCatalogHarness(): Promise<CatalogHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new TestClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const fixtures = createCatalogDevFixtures();
  const moduleRef = await Test.createTestingModule({
    imports: [PlatformModule.forRoot(config, { clock, ids }), TestAuthModule.register(), CatalogModule.forRoot(config, fixtures)],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  for (const [id, slug, nameAr] of [
    [STORE_A, "store-a", "متجر أ"],
    [STORE_B, "store-b", "متجر ب"],
  ] as const) {
    fixtures.stores.set({
      id,
      slug,
      nameAr,
      kind: "local",
      verifiedBadge: false,
      liveDrop: false,
      isFavorite: false,
      visible: true,
      legal: { legalName: `Legal ${slug}`, commercialRegisterNo: "CR-1", taxCardNo: "TC-1", governorate: "Cairo", approved: true },
    });
  }
  return { app, clock, fixtures, config, http: () => request(app.getHttpServer()), close: () => app.close() };
}

let idemCounter = 0;
/** A fresh UUIDv7-shaped idempotency key. */
export function idemKey(): string {
  idemCounter += 1;
  return `0192f3a4-5b6c-7d8e-9f01-${String(500_000_000_000 + idemCounter).padStart(12, "0")}`;
}

export const bearer = (p: TestPrincipal | string): Record<string, string> => ({
  Authorization: `Bearer ${typeof p === "string" ? p : p.token}`,
});
