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
  InMemoryStylistStore,
  StaticStylistFlags,
  FLAG_ML,
} from "../../stylist";
import { catalog } from "./stylist-fixtures";
import { FakeNotifier, InMemoryCalendarStore, StaticEta } from "../adapters/in-memory";
import { OutfitCalendarModule } from "../calendar.module";
import { FLAG_GAP_FILL, FLAG_REMINDERS, type CalendarConfig, type StylistPorts } from "../application/shared";

export const START_MS = 1_800_000_000_000; // 2027-01-15 08:00 UTC
export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;

export class FakeClock implements Clock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(ms: number): void {
    this.ms = ms;
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

const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });

export const USERS = { a: U(1), b: U(2) };
export const TOKENS = {
  a: "token-shopper-a-000000000000001",
  b: "token-shopper-b-000000000000002",
  aOnSellerAud: "token-shopper-a-on-seller-0000003",
};

export interface CalendarHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly store: InMemoryCalendarStore;
  readonly notifier: FakeNotifier;
  readonly eta: StaticEta;
  readonly stylist: {
    readonly candidates: FakeCandidateSource;
    readonly embeddings: FakeEmbeddings;
    readonly budget: FakeBudget;
    readonly personalization: FakePersonalization;
    readonly live: FakeLivePrices;
    readonly bag: FakeBag;
    readonly flags: StaticStylistFlags;
    readonly outfits: InMemoryStylistStore;
  };
  readonly flags: StaticStylistFlags;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createCalendarHarness(over: { config?: CalendarConfig } = {}): Promise<CalendarHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.a, shopper(USERS.a), "buyer_api");
  tokens.add(TOKENS.b, shopper(USERS.b), "buyer_api");
  tokens.add(TOKENS.aOnSellerAud, shopper(USERS.a), "seller_api");

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const candidates = new FakeCandidateSource();
  candidates.items = catalog();
  const live = new FakeLivePrices();
  for (const c of candidates.items) live.prices.set(c.itemId, { pricePiastres: c.pricePiastres, storeId: c.storeId, inStockInSize: true });
  const stylist = {
    candidates,
    embeddings: new FakeEmbeddings(),
    budget: new FakeBudget(),
    personalization: new FakePersonalization(),
    live,
    bag: new FakeBag(),
    flags: new StaticStylistFlags(new Set([FLAG_ML])),
    outfits: new InMemoryStylistStore(),
  };
  const flags = new StaticStylistFlags(new Set([FLAG_GAP_FILL, FLAG_REMINDERS]));
  const store = new InMemoryCalendarStore();
  const notifier = new FakeNotifier();
  const eta = new StaticEta();
  const ports: StylistPorts = stylist;

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      OutfitCalendarModule.forRoot(config, { store, notifier, eta, flags, stylist: ports, ...(over.config === undefined ? {} : { config: over.config }) }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, clock, store, notifier, eta, stylist, flags, http: () => request(app.getHttpServer()), close: () => app.close() };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
