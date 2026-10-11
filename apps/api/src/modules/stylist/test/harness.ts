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
  FakeBag,
  FakeBudget,
  FakeCandidateSource,
  FakeEmbeddings,
  FakeLivePrices,
  FakePersonalization,
  FakeStylistLlm,
  InMemoryStylistStore,
  StaticStylistFlags,
} from "../adapters/in-memory";
import { StylistModule } from "../stylist.module";
import { DEFAULT_STYLIST_CONFIG, type StylistConfig } from "../application/shared";
import { FLAG_LLM, FLAG_ML } from "../application/shared";
import { START_MS, U, catalog, IDEM } from "./fixtures";

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

class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, Subject>();
  add(token: string, subject: Subject): void {
    this.subjects.set(token, subject);
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

const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });
const seller = (id: string): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "brand", storeId: U(9001), role: "owner" }],
  tokenScopes: ["seller:read", "seller:write"],
});

export const USERS = { a: U(1), b: U(2), seller: U(11) };
export const TOKENS = {
  a: "token-shopper-a-000000000000001",
  b: "token-shopper-b-000000000000002",
  sellerOnBuyerAud: "token-seller-on-buyer-aud-0000011",
  shopperOnSellerAud: "token-shopper-on-seller-aud-000012",
};

export interface StylistHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly store: InMemoryStylistStore;
  readonly candidates: FakeCandidateSource;
  readonly embeddings: FakeEmbeddings;
  readonly budget: FakeBudget;
  readonly personalization: FakePersonalization;
  readonly live: FakeLivePrices;
  readonly bag: FakeBag;
  readonly flags: StaticStylistFlags;
  readonly llm: FakeStylistLlm;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createStylistHarness(over: { config?: StylistConfig } = {}): Promise<StylistHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.a, { actor: shopper(USERS.a), aud: "buyer_api" });
  tokens.add(TOKENS.b, { actor: shopper(USERS.b), aud: "buyer_api" });
  tokens.add(TOKENS.sellerOnBuyerAud, { actor: seller(USERS.seller), aud: "buyer_api" });
  tokens.add(TOKENS.shopperOnSellerAud, { actor: shopper(USERS.a), aud: "seller_api" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const store = new InMemoryStylistStore();
  const candidates = new FakeCandidateSource();
  candidates.items = catalog();
  const embeddings = new FakeEmbeddings();
  const budget = new FakeBudget();
  const personalization = new FakePersonalization();
  const live = new FakeLivePrices();
  for (const c of candidates.items) live.prices.set(c.itemId, { pricePiastres: c.pricePiastres, storeId: c.storeId, inStockInSize: true });
  const bag = new FakeBag();
  const flags = new StaticStylistFlags(new Set([FLAG_ML, FLAG_LLM]));
  const llm = new FakeStylistLlm();

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      StylistModule.forRoot(config, {
        store,
        candidates,
        embeddings,
        budget,
        personalization,
        live,
        bag,
        flags,
        llm,
        config: over.config ?? DEFAULT_STYLIST_CONFIG,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return {
    app,
    clock,
    store,
    candidates,
    embeddings,
    budget,
    personalization,
    live,
    bag,
    flags,
    llm,
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
export { IDEM };
