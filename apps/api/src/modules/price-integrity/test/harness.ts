import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Actor, Grant } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig, type AppConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator, type Clock } from "../../../platform";
import { createPriceIntegrityDevFixtures, type PriceIntegrityDevFixtures } from "../adapters/in-memory";
import { PriceIntegrityModule } from "../price-integrity.module";
import { PRICE_INTEGRITY_SERVICE } from "../adapters/tokens";
import type { PriceIntegrityService } from "../application/service";

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
export const SKU_1 = uid(7001);
export const SKU_2 = uid(7002);
export const PRODUCT_A = uid(8001);
export const PRODUCT_HIDDEN = uid(8002);
export const MISSING = uid(8999);

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
  supportA: seller(13, "seller-token-support-a1", [{ kind: "brand", storeId: STORE_A, role: "support" }]),
  ownerB: seller(21, "seller-token-owner-b-01", [{ kind: "brand", storeId: STORE_B, role: "owner" }]),
  multi: seller(31, "seller-token-multi-0001", [
    { kind: "brand", storeId: STORE_A, role: "owner" },
    { kind: "brand", storeId: STORE_B, role: "owner" },
  ]),
  noGrants: seller(41, "seller-token-nogrant-01", []),
  sellerSuspended: seller(51, "seller-token-suspend-01", [{ kind: "brand", storeId: STORE_A, role: "owner" }], { status: "suspended" }),
  /** A seller token must never work on the buyer audience route, and vice versa. */
  noScopeA: seller(61, "seller-token-noscope-01", [{ kind: "brand", storeId: STORE_A, role: "owner" }], { tokenScopes: [] }),
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
    return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: new TestAuthenticator() }], exports: [AUTHENTICATOR] };
  }
}

export interface PriceIntegrityHarness {
  readonly app: INestApplication;
  readonly clock: TestClock;
  readonly fixtures: PriceIntegrityDevFixtures;
  readonly service: PriceIntegrityService;
  readonly config: AppConfig;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

/** The integrator registers the module in app.module.ts; until then this harness exercises it over HTTP. */
export async function createPriceIntegrityHarness(): Promise<PriceIntegrityHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new TestClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const fixtures = createPriceIntegrityDevFixtures();
  const moduleRef = await Test.createTestingModule({
    imports: [PlatformModule.forRoot(config, { clock, ids }), TestAuthModule.register(), PriceIntegrityModule.forRoot(config, fixtures)],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  const service = app.get<PriceIntegrityService>(PRICE_INTEGRITY_SERVICE);
  return { app, clock, fixtures, service, config, http: () => request(app.getHttpServer()), close: () => app.close() };
}

export const bearer = (p: TestPrincipal | string): Record<string, string> => ({
  Authorization: `Bearer ${typeof p === "string" ? p : p.token}`,
});
