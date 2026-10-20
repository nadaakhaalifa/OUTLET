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
  FakeCatalog,
  FakePersonalization,
  RecommendationsModule,
  type FakeAffordability,
} from "../../recommendations";
import { InMemoryEvalRunStore, InMemoryShadowLogStore, RankingModule, StaticRankingFlags, type RankerV2Port } from "../index";
import { LinearRanker, type Candidate, type RankingFeatureVector } from "../domain/bridge";

export const START_MS = 1_800_000_000_000;
export const DAY = 86_400_000;
export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const P = (n: number): string => `00000000-0000-4000-8000-${String(7000 + n).padStart(12, "0")}`;
export const S = (n: number): string => `00000000-0000-4000-8000-${String(9000 + n).padStart(12, "0")}`;
export const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;

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
    const claims: AccessClaims = { iss: "test", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `jti-${bearer}`, sid: `sid-${bearer}`, amr: ["otp_sms"] };
    return { actor: s.actor, claims };
  }
}

export const TOKENS = {
  shopper: "token-shopper-a-000000000000001",
  seller: "token-seller-owner-000000000011",
  ops: "token-admin-ops-0000000000000012",
  superAdmin: "token-admin-super-00000000000013",
  marketing: "token-admin-marketing-000000014",
  support: "token-admin-support-0000000015",
  shopperOnAdminAud: "token-shopper-on-admin-aud-016",
};

const admin = (id: string, role: "ops" | "super_admin" | "marketing" | "support"): Actor => ({
  id,
  status: "active",
  assurance: "passkey",
  grants: [{ kind: "admin", role }],
  tokenScopes: ["admin:access"],
});

/** Records every vector the shadow ranker is asked to score. */
export class SpyRankerV2 implements RankerV2Port {
  readonly modelVersion = "linear-baseline-v2";
  readonly seen: RankingFeatureVector[][] = [];
  private readonly inner = new LinearRanker();
  async score(batch: readonly RankingFeatureVector[]): Promise<readonly number[]> {
    this.seen.push([...batch]);
    return this.inner.score(batch);
  }
}

export const cand = (n: number, store: number, over: Partial<Candidate> = {}): Candidate => ({
  productId: P(n),
  storeId: S(store),
  categoryId: "dress",
  popularity: 100 - n,
  createdAtMs: START_MS - DAY,
  priceMinor: 100_000n,
  claimAllowed: true,
  verifiedDiscountPct: 10 + (n % 30),
  sellerHealth: 80,
  priceTrust: 80,
  returnRatePermille: 40,
  storeActive: true,
  inStock: true,
  sizesInStock: [],
  isNewSeller: false,
  ...over,
});

export interface RankingHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly shadow: InMemoryShadowLogStore;
  readonly evals: InMemoryEvalRunStore;
  readonly flags: StaticRankingFlags;
  readonly ranker: SpyRankerV2;
  readonly catalog: FakeCatalog;
  readonly personalization: FakePersonalization;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createRankingHarness(opts: { affordability?: FakeAffordability } = {}): Promise<RankingHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  const shopper: Actor = { id: U(1), status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] };
  tokens.add(TOKENS.shopper, shopper, "buyer_api");
  tokens.add(TOKENS.shopperOnAdminAud, shopper, "admin_api");
  tokens.add(
    TOKENS.seller,
    { id: U(11), status: "active", assurance: "basic", grants: [{ kind: "brand", storeId: S(1), role: "owner" }], tokenScopes: ["seller:read", "seller:write"] },
    "seller_api",
  );
  tokens.add(TOKENS.ops, admin(U(12), "ops"), "admin_api");
  tokens.add(TOKENS.superAdmin, admin(U(13), "super_admin"), "admin_api");
  tokens.add(TOKENS.marketing, admin(U(14), "marketing"), "admin_api");
  tokens.add(TOKENS.support, admin(U(15), "support"), "admin_api");

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const shadow = new InMemoryShadowLogStore();
  const evals = new InMemoryEvalRunStore();
  const flags = new StaticRankingFlags(true);
  const ranker = new SpyRankerV2();
  const catalog = new FakeCatalog();
  const personalization = new FakePersonalization();
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      RankingModule.forRoot(config, { shadowStore: shadow, evalStore: evals, ranker, flags }),
      RecommendationsModule.forRoot(config, { catalog, personalization, ...(opts.affordability === undefined ? {} : { affordability: opts.affordability }) }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, clock, shadow, evals, flags, ranker, catalog, personalization, http: () => request(app.getHttpServer()), close: () => app.close() };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
