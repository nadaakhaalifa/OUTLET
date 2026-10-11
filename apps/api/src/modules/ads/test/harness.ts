import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, BrandRole } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator, type Clock } from "../../../platform";
import {
  FakeAdsFlags,
  FakeAttribution,
  FakeBotScore,
  FakeChargeIntents,
  FakeEligibility,
  FakeEnforcement,
  FakeLedger,
  FakeSecret,
  InMemoryAdsStore,
} from "../adapters/in-memory";
import { ConfirmTopUp, FailTopUp, GetBalance, RequestTopUp } from "../application/billing";
import { ApplyEnforcement, ChangeCampaignStatus, CreateCampaign, EndExpiredCampaigns, GetCampaign, ListCampaigns, UpdateCampaign } from "../application/campaigns";
import { CreditBackClick, PostClickSpend, RecordClick } from "../application/clicks";
import { GetAdsConfig, PutAdsConfig } from "../application/config";
import { GetAdReports } from "../application/reports";
import { SelectSponsored } from "../application/selection";
import type { AdsDeps } from "../application/shared";
import { AdsModule } from "../ads.module";

export const START_MS = Date.parse("2026-04-15T09:00:00Z");
export const DAY = 86_400_000;
export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
export const EGP = (n: number): bigint => BigInt(n) * 100n;
export const STORE_A = U(9001);
export const STORE_B = U(9002);
export const P_A1 = U(7001);
export const P_A2 = U(7002);
export const P_B1 = U(7101);

export class FakeClock implements Clock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export function createRuntime() {
  const clock = new FakeClock();
  let n = 0;
  const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}` };
  const store = new InMemoryAdsStore();
  const flags = new FakeAdsFlags();
  const enforcement = new FakeEnforcement();
  const eligibility = new FakeEligibility();
  const charges = new FakeChargeIntents();
  const ledger = new FakeLedger();
  const bots = new FakeBotScore();
  const attribution = new FakeAttribution();
  const secret = new FakeSecret();
  eligibility.seed({ productId: P_A1, storeId: STORE_A });
  eligibility.seed({ productId: P_A2, storeId: STORE_A, categoryIds: ["dresses"] });
  eligibility.seed({ productId: P_B1, storeId: STORE_B });
  const d: AdsDeps = { store, clock, ids, flags, enforcement, eligibility, charges, ledger, bots, attribution, secret };
  return {
    d,
    clock,
    store,
    flags,
    enforcement,
    eligibility,
    charges,
    ledger,
    bots,
    attribution,
    secret,
    create: new CreateCampaign(d),
    update: new UpdateCampaign(d),
    status: new ChangeCampaignStatus(d),
    getOne: new GetCampaign(d),
    list: new ListCampaigns(d),
    enforce: new ApplyEnforcement(d),
    end: new EndExpiredCampaigns(d),
    topUp: new RequestTopUp(d),
    confirm: new ConfirmTopUp(d),
    fail: new FailTopUp(d),
    balance: new GetBalance(d),
    select: new SelectSponsored(d),
    click: new RecordClick(d),
    post: new PostClickSpend(d),
    creditBack: new CreditBackClick(d),
    reports: new GetAdReports(d),
    getConfig: new GetAdsConfig(d),
    putConfig: new PutAdsConfig(d),
  };
}
export type Runtime = ReturnType<typeof createRuntime>;

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
  shopper: "token-shopper-a-000000000000001",
  ownerA: "token-owner-store-a-00000000002",
  financeA: "token-finance-store-a-0000000003",
  supportA: "token-support-store-a-0000000004",
  ownerB: "token-owner-store-b-00000000005",
  admin: "token-admin-marketing-000000006",
  adminSupport: "token-admin-support-0000000007",
  shopperOnSellerAud: "token-shopper-on-seller-aud-08",
};

const brand = (id: string, storeId: string, role: BrandRole): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "brand", storeId, role }],
  tokenScopes: ["seller:read", "seller:write"],
});

export interface AdsHarness {
  readonly app: INestApplication;
  readonly rt: Runtime;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createAdsHarness(): Promise<AdsHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const rt = createRuntime();
  const ids = createIdGenerator(rt.clock, nodeCsprng);
  const tokens = new TokenTable();
  const shopper: Actor = { id: U(1), status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] };
  tokens.add(TOKENS.shopper, { actor: shopper, aud: "buyer_api" });
  tokens.add(TOKENS.shopperOnSellerAud, { actor: shopper, aud: "seller_api" });
  tokens.add(TOKENS.ownerA, { actor: brand(U(11), STORE_A, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.financeA, { actor: brand(U(12), STORE_A, "finance"), aud: "seller_api" });
  tokens.add(TOKENS.supportA, { actor: brand(U(13), STORE_A, "support"), aud: "seller_api" });
  tokens.add(TOKENS.ownerB, { actor: brand(U(14), STORE_B, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.admin, {
    actor: { id: U(21), status: "active", assurance: "passkey", grants: [{ kind: "admin", role: "marketing" }], tokenScopes: ["admin:access"] },
    aud: "admin_api",
  });
  tokens.add(TOKENS.adminSupport, {
    actor: { id: U(22), status: "active", assurance: "passkey", grants: [{ kind: "admin", role: "support" }], tokenScopes: ["admin:access"] },
    aud: "admin_api",
  });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock: rt.clock, ids }),
      TestAuthModule.register(),
      AdsModule.forRoot(config, {
        store: rt.store,
        flags: rt.flags,
        enforcement: rt.enforcement,
        eligibility: rt.eligibility,
        charges: rt.charges,
        ledger: rt.ledger,
        bots: rt.bots,
        attribution: rt.attribution,
        secret: rt.secret,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, rt, http: () => request(app.getHttpServer()), close: () => app.close() };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
