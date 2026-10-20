import "reflect-metadata";
import { Global, Module, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, BrandRole } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { PlatformModule, createIdGenerator, nodeCsprng, type Authenticator, type Clock } from "../../../platform";
import { AUTHENTICATOR } from "../../../platform/tokens";
import {
  FIELD_CIPHER,
  FIT_CATALOG,
  FIT_FEEDBACK_REPOSITORY,
  MEASUREMENTS_CONSENT,
  ORDER_LINE_FIT,
  SIZE_DEMAND_REPOSITORY,
  SIZE_PROFILE_REPOSITORY,
  SIZING_EVENTS,
} from "../adapters/tokens";
import {
  type DevAesGcmFieldCipher,
  type InMemoryDemandRepository,
  type InMemoryFeedbackRepository,
  type InMemoryFitCatalog,
  type InMemoryMeasurementsConsent,
  type InMemoryOrderLines,
  type InMemorySizeProfileRepository,
  type InMemorySizingEventLog,
} from "../adapters/in-memory";
import { SizingModule } from "../sizing.module";

export const START_MS = 1_800_000_000_000;

class TestClock implements Clock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
}

const u = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
export const USER_A = u(1);
export const USER_B = u(2);
export const STORE_A = u(101);
export const STORE_B = u(102);
export const BRAND_X = u(201);
export const BRAND_Y = u(202);
export const PRODUCT_1 = u(301);
export const PRODUCT_2 = u(302);
export const PRODUCT_NO_CHART = u(303);
export const ZERO_PROFILE = u(999);
export const IDEM_1 = "0192f3a4-5b6c-7d8e-9f01-23456789abc1";
export const IDEM_2 = "0192f3a4-5b6c-7d8e-9f01-23456789abc2";
export const IDEM_3 = "0192f3a4-5b6c-7d8e-9f01-23456789abc3";

export const TOKENS = {
  buyerA: "buyer-token-userA-0000000001",
  buyerB: "buyer-token-userB-0000000002",
  sellerOwnerA: "seller-token-ownerA-00000001",
  sellerCatalogA: "seller-token-catalogA-0000001",
  sellerSupportA: "seller-token-supportA-0000001",
  sellerOwnerB: "seller-token-ownerB-00000001",
  /** Buyer audience but carrying a brand grant: audience must still block seller routes. */
  buyerWithBrand: "buyer-token-withbrand-0000001",
} as const;

interface Identity {
  readonly actor: Actor;
  readonly aud: AccessClaims["aud"];
}

const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });
const staff = (id: string, storeId: string, role: BrandRole): Actor => ({
  id,
  status: "active",
  assurance: "passkey",
  grants: [{ kind: "brand", storeId, role }],
  tokenScopes: ["seller:read", "seller:write"],
});

const IDENTITIES: Readonly<Record<string, Identity>> = {
  [TOKENS.buyerA]: { actor: shopper(USER_A), aud: "buyer_api" },
  [TOKENS.buyerB]: { actor: shopper(USER_B), aud: "buyer_api" },
  [TOKENS.sellerOwnerA]: { actor: staff(u(11), STORE_A, "owner"), aud: "seller_api" },
  [TOKENS.sellerCatalogA]: { actor: staff(u(12), STORE_A, "catalog"), aud: "seller_api" },
  [TOKENS.sellerSupportA]: { actor: staff(u(13), STORE_A, "support"), aud: "seller_api" },
  [TOKENS.sellerOwnerB]: { actor: staff(u(14), STORE_B, "owner"), aud: "seller_api" },
  [TOKENS.buyerWithBrand]: { actor: staff(u(15), STORE_A, "owner"), aud: "buyer_api" },
};

class FakeAuthenticator implements Authenticator {
  async authenticate(token: string, nowMs: number) {
    const id = IDENTITIES[token];
    if (id === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    const claims: AccessClaims = {
      iss: "test",
      sub: id.actor.id,
      aud: id.aud,
      iat,
      exp: iat + 600,
      jti: `jti-${token}`,
      sid: `sid-${token}`,
      amr: ["otp_sms"],
    };
    return { actor: id.actor, claims };
  }
}

/** Test-only global module: the real AuthModule is not needed to exercise this module's routes. */
@Global()
@Module({ providers: [{ provide: AUTHENTICATOR, useValue: new FakeAuthenticator() }], exports: [AUTHENTICATOR] })
class TestAuthModule {}

export interface SizingHarness {
  readonly app: INestApplication;
  readonly consent: InMemoryMeasurementsConsent;
  readonly catalog: InMemoryFitCatalog;
  readonly lines: InMemoryOrderLines;
  readonly feedback: InMemoryFeedbackRepository;
  readonly demand: InMemoryDemandRepository;
  readonly profiles: InMemorySizeProfileRepository;
  readonly cipher: DevAesGcmFieldCipher;
  readonly events: InMemorySizingEventLog;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createSizingHarness(): Promise<SizingHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new TestClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const moduleRef = await Test.createTestingModule({
    imports: [PlatformModule.forRoot(config, { clock, ids }), TestAuthModule, SizingModule.forRoot(config)],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  const get = <T>(token: symbol): T => app.get<T>(token, { strict: false });
  return {
    app,
    consent: get(MEASUREMENTS_CONSENT),
    catalog: get(FIT_CATALOG),
    lines: get(ORDER_LINE_FIT),
    feedback: get(FIT_FEEDBACK_REPOSITORY),
    demand: get(SIZE_DEMAND_REPOSITORY),
    profiles: get(SIZE_PROFILE_REPOSITORY),
    cipher: get(FIELD_CIPHER),
    events: get(SIZING_EVENTS),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export const auth = (token: string): { Authorization: string } => ({ Authorization: `Bearer ${token}` });

export const TOPS_ROWS = [
  { size_label: "XS", measurements: { bust_cm: 82, waist_cm: 64 } },
  { size_label: "S", measurements: { bust_cm: 86, waist_cm: 68 } },
  { size_label: "M", measurements: { bust_cm: 90, waist_cm: 72 } },
  { size_label: "L", measurements: { bust_cm: 96, waist_cm: 78 } },
  { size_label: "XL", measurements: { bust_cm: 102, waist_cm: 84 } },
] as const;
