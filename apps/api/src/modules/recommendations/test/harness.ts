import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator, type Clock } from "../../../platform";
import {
  FakeConsent,
  FakeFlags as HistoryFlags,
  FakeProductLookup,
  HistoryModule,
  HistoryPersonalizationRead,
  InMemoryHistoryStore,
  type BuildResult,
  type ProductSnapshot,
  type RecordEventInput,
  type RecordResult,
  type SweepReport,
} from "../../history";
import {
  FakeCatalog,
  FakeFlags,
  FakeUserSizes,
  InMemoryRecoStore,
  InMemoryVectorIndex,
  RecommendationsModule,
  SeededRngPort,
  SpyRanker,
} from "../index";
import type { FakeAffordability } from "../index";
import type { PersonalizationReadPort } from "../domain/ports";
import type { Candidate } from "../domain/bridge";
import * as H from "../../history";

// Structural views of the history use cases (history's public index exports tokens and result
// types, not the classes). Keeps this harness on the module's public surface only.
interface BuildUserFeatures {
  execute(userId: string): Promise<BuildResult>;
}
interface SweepClearRequests {
  execute(limit?: number): Promise<SweepReport>;
}
interface RecordHistoryEvent {
  execute(i: RecordEventInput): Promise<RecordResult>;
}

export const START_MS = 1_800_000_000_000;
export const DAY = 86_400_000;

export class FakeClock implements Clock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, { actor: Actor; aud: AccessClaims["aud"] }>();
  add(token: string, actor: Actor, aud: AccessClaims["aud"]): void {
    this.subjects.set(token, { actor, aud });
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
export const P = (n: number): string => `00000000-0000-4000-8000-${String(7000 + n).padStart(12, "0")}`;
export const S = (n: number): string => `00000000-0000-4000-8000-${String(9000 + n).padStart(12, "0")}`;
export const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;

export const USERS = { a: U(1), b: U(2) };
export const TOKENS = {
  a: "token-shopper-a-000000000000001",
  b: "token-shopper-b-000000000000002",
  seller: "token-seller-owner-000000000011",
  admin: "token-admin-support-0000000012",
};

const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });

export const cand = (n: number, store: number, over: Partial<Candidate> = {}): Candidate => ({
  productId: P(n),
  storeId: S(store),
  categoryId: "dress",
  popularity: 100 - n,
  createdAtMs: START_MS - DAY,
  priceMinor: 100_000n,
  claimAllowed: false,
  verifiedDiscountPct: 0,
  sellerHealth: 80,
  priceTrust: 80,
  returnRatePermille: 40,
  storeActive: true,
  inStock: true,
  sizesInStock: [],
  isNewSeller: false,
  ...over,
});

/** Spy wrapper around the history read side: records every feature-store read. */
export class SpyPersonalization implements PersonalizationReadPort {
  readonly featureReads: string[] = [];
  constructor(private readonly inner: HistoryPersonalizationRead) {}
  settings(u: string) {
    return this.inner.settings(u);
  }
  consentGranted(u: string) {
    return this.inner.consentGranted(u);
  }
  async features(u: string) {
    this.featureReads.push(u);
    return this.inner.features(u);
  }
  recentViews(u: string, l: number) {
    return this.inner.recentViews(u, l);
  }
  purchases(u: string, l: number) {
    return this.inner.purchases(u, l);
  }
}

export interface Harness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly history: InMemoryHistoryStore;
  readonly reco: InMemoryRecoStore;
  readonly catalog: FakeCatalog;
  readonly vectors: InMemoryVectorIndex;
  readonly ranker: SpyRanker;
  readonly personalization: SpyPersonalization;
  readonly consent: FakeConsent;
  readonly sizes: FakeUserSizes;
  readonly flags: FakeFlags;
  readonly products: FakeProductLookup;
  readonly build: BuildUserFeatures;
  readonly sweep: SweepClearRequests;
  readonly record: RecordHistoryEvent;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
  /** Registers a product in both the catalog (ranking) and the history snapshot port. */
  addProduct(c: Candidate): void;
}

export async function createHarness(opts: { affordability?: FakeAffordability } = {}): Promise<Harness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.a, shopper(USERS.a), "buyer_api");
  tokens.add(TOKENS.b, shopper(USERS.b), "buyer_api");
  tokens.add(
    TOKENS.seller,
    { id: U(11), status: "active", assurance: "basic", grants: [{ kind: "brand", storeId: S(1), role: "owner" }], tokenScopes: ["seller:read", "seller:write"] },
    "seller_api",
  );
  tokens.add(
    TOKENS.admin,
    { id: U(12), status: "active", assurance: "passkey", grants: [{ kind: "admin", role: "support" }], tokenScopes: ["admin:access"] },
    "admin_api",
  );

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const historyStore = new InMemoryHistoryStore();
  const consent = new FakeConsent();
  const products = new FakeProductLookup();
  const historyFlags = new HistoryFlags();
  const flags = new FakeFlags();
  const catalog = new FakeCatalog();
  const vectors = new InMemoryVectorIndex();
  const ranker = new SpyRanker();
  const sizes = new FakeUserSizes();
  const recoStore = new InMemoryRecoStore();
  const personalization = new SpyPersonalization(new HistoryPersonalizationRead(historyStore, consent, clock));

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      HistoryModule.forRoot(config, { store: historyStore, consent, products, flags: historyFlags }),
      RecommendationsModule.forRoot(config, {
        store: recoStore,
        catalog,
        vectors,
        ranker,
        personalization,
        sizes,
        flags,
        rng: new SeededRngPort(7),
        ...(opts.affordability === undefined ? {} : { affordability: opts.affordability }),
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
    history: historyStore,
    reco: recoStore,
    catalog,
    vectors,
    ranker,
    personalization,
    consent,
    sizes,
    flags,
    products,
    build: get(H.BUILD_USER_FEATURES),
    sweep: get(H.SWEEP_CLEAR_REQUESTS),
    record: get(H.RECORD_HISTORY_EVENT),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
    addProduct(c) {
      catalog.add(c);
      const snap: ProductSnapshot = {
        productId: c.productId,
        storeId: c.storeId,
        categoryId: c.categoryId,
        priceMinor: c.priceMinor,
        storeActive: c.storeActive,
      };
      products.set(snap);
    },
  };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
