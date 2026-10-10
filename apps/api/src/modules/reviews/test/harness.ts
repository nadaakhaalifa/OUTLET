import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, AdminRole, BrandRole } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import {
  AUTHENTICATOR,
  PlatformModule,
  createIdGenerator,
  nodeCsprng,
  type Authenticator,
  type Clock,
} from "../../../platform";
import {
  FakeImageClassifier,
  FakePhotoUploads,
  FakeProductStore,
  FakePurchaseVerification,
  FakeReviewerProfiles,
  FakeSellerIdentity,
  FakeToxicityClassifier,
  InMemoryReviewStore,
} from "../adapters/in-memory";
import * as T from "../adapters/tokens";
import type { ProcessModerationBacklog } from "../application/moderation";
import type { SweepQaSla } from "../application/qa";
import type { DeliveredLine } from "../domain/bridge";
import { ReviewsModule } from "../reviews.module";

export const START_MS = 1_800_000_000_000;
export const HOUR = 3_600_000;

export class FakeClock implements Clock {
  constructor(private ms = START_MS) {}
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

/** Opaque bearer strings to prepared principals. The real authenticator belongs to the auth module. */
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
    const claims: AccessClaims = {
      iss: "test",
      sub: s.actor.id,
      aud: s.aud,
      iat,
      exp: iat + 600,
      jti: `jti-${bearer}`,
      sid: `sid-${bearer}`,
      amr: ["otp_sms"],
    };
    return { actor: s.actor, claims };
  }
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;

export const STORE_A = U(9001);
export const STORE_B = U(9002);
export const PRODUCT_1 = U(7001);
export const PRODUCT_2 = U(7002);

export const shopperActor = (id: string): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "shopper" }],
  tokenScopes: [],
});

export const sellerActor = (id: string, storeId: string, role: BrandRole): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "brand", storeId, role }],
  tokenScopes: ["seller:read", "seller:write"],
});

export const adminActor = (id: string, role: AdminRole): Actor => ({
  id,
  status: "active",
  assurance: "passkey",
  grants: [{ kind: "admin", role }],
  tokenScopes: ["admin:access"],
});

export const USERS = { s1: U(1), s2: U(2), s3: U(3), s4: U(4), s5: U(5), s6: U(6), s7: U(7), s8: U(8), s9: U(9), sellerShopper: U(10) };

export const TOKENS = {
  s1: "token-shopper-1-0000000000001",
  s2: "token-shopper-2-0000000000002",
  s3: "token-shopper-3-0000000000003",
  s4: "token-shopper-4-0000000000004",
  s5: "token-shopper-5-0000000000005",
  s6: "token-shopper-6-0000000000006",
  s7: "token-shopper-7-0000000000007",
  s8: "token-shopper-8-0000000000008",
  s9: "token-shopper-9-0000000000009",
  sellerShopper: "token-seller-as-shopper-00010",
  ownerA: "token-seller-owner-a-0000011",
  catalogA: "token-seller-catalog-a-00012",
  supportA: "token-seller-support-a-00013",
  ownerB: "token-seller-owner-b-0000014",
  shopperOnSellerAud: "token-shopper-on-seller-aud-15",
  sellerOnBuyerAud: "token-seller-on-buyer-aud-0016",
  moderator: "token-admin-trust-safety-00017",
  adminSupport: "token-admin-support-0000018",
  shopperOnAdminAud: "token-shopper-on-admin-aud-19",
};

export interface ReviewsHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly store: InMemoryReviewStore;
  readonly purchases: FakePurchaseVerification;
  readonly sellers: FakeSellerIdentity;
  readonly products: FakeProductStore;
  readonly profiles: FakeReviewerProfiles;
  readonly photos: FakePhotoUploads;
  readonly images: FakeImageClassifier;
  readonly sweepSla: SweepQaSla;
  readonly backlog: ProcessModerationBacklog;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
  /** Registers a delivered line bought by `userId` in store A (default) for product 1. */
  deliver(n: number, userId: string, over?: Partial<DeliveredLine>): DeliveredLine;
}

export async function createReviewsHarness(): Promise<ReviewsHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  const buyer = (t: string, id: string): void => void tokens.add(t, { actor: shopperActor(id), aud: "buyer_api" });
  buyer(TOKENS.s1, USERS.s1);
  buyer(TOKENS.s2, USERS.s2);
  buyer(TOKENS.s3, USERS.s3);
  buyer(TOKENS.s4, USERS.s4);
  buyer(TOKENS.s5, USERS.s5);
  buyer(TOKENS.s6, USERS.s6);
  buyer(TOKENS.s7, USERS.s7);
  buyer(TOKENS.s8, USERS.s8);
  buyer(TOKENS.s9, USERS.s9);
  buyer(TOKENS.sellerShopper, USERS.sellerShopper);
  tokens.add(TOKENS.ownerA, { actor: sellerActor(U(11), STORE_A, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.catalogA, { actor: sellerActor(U(12), STORE_A, "catalog"), aud: "seller_api" });
  tokens.add(TOKENS.supportA, { actor: sellerActor(U(13), STORE_A, "support"), aud: "seller_api" });
  tokens.add(TOKENS.ownerB, { actor: sellerActor(U(14), STORE_B, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.shopperOnSellerAud, { actor: shopperActor(USERS.s1), aud: "seller_api" });
  tokens.add(TOKENS.sellerOnBuyerAud, { actor: sellerActor(U(11), STORE_A, "owner"), aud: "buyer_api" });
  tokens.add(TOKENS.moderator, { actor: adminActor(U(21), "trust_safety"), aud: "admin_api" });
  tokens.add(TOKENS.adminSupport, { actor: adminActor(U(22), "support"), aud: "admin_api" });
  tokens.add(TOKENS.shopperOnAdminAud, { actor: shopperActor(USERS.s1), aud: "admin_api" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const store = new InMemoryReviewStore();
  const purchases = new FakePurchaseVerification();
  const sellers = new FakeSellerIdentity();
  const products = new FakeProductStore();
  const profiles = new FakeReviewerProfiles();
  const photos = new FakePhotoUploads();
  const images = new FakeImageClassifier();
  products.set(PRODUCT_1, STORE_A);
  products.set(PRODUCT_2, STORE_B);
  sellers.grant(USERS.sellerShopper, STORE_A);
  profiles.set(USERS.s1, "Sara");
  profiles.set(USERS.s2, "mona");

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      ReviewsModule.forRoot(config, {
        store,
        purchases,
        sellers,
        products,
        profiles,
        photos,
        images,
        toxicity: new FakeToxicityClassifier(),
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  const get = <X>(token: symbol): X => app.get<X>(token, { strict: false });
  return {
    app,
    clock,
    store,
    purchases,
    sellers,
    products,
    profiles,
    photos,
    images,
    sweepSla: get(T.SWEEP_QA_SLA),
    backlog: get(T.PROCESS_MODERATION_BACKLOG),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
    deliver(n, userId, over = {}) {
      const line: DeliveredLine = {
        orderLineId: U(500 + n),
        userId,
        storeId: STORE_A,
        productId: PRODUCT_1,
        sizeLabel: "M",
        deliveredAtMs: clock.nowMs() - 24 * HOUR,
        ...over,
      };
      purchases.add(line);
      return line;
    },
  };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
