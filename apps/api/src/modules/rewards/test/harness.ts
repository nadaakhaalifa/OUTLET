import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, AdminRole } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator, type Clock } from "../../../platform";
import {
  FakeApprovals,
  FakeAttestation,
  FakeLedger,
  FakePlusEntitlements,
  FakeStoreCredit,
  FakeVouchers,
  NodeHash,
  SequenceRandom,
  StaticRewardsSwitch,
} from "../adapters/fakes";
import { InMemoryRewardsStore } from "../adapters/in-memory";
import * as T from "../adapters/tokens";
import type { GetOdds, PlayGame, PublishOdds } from "../application/games";
import type { RewardsDeps } from "../application/shared";
import type { IngestRewardTrigger } from "../application/triggers";
import type { SweepRewards } from "../application/view";
import type { TierService } from "../application/tiers";
import { RewardsModule } from "../rewards.module";

export const START_MS = 1_800_000_000_000;
export const DAY = 86_400_000;
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

let idSeq = 0;
export const seqIds = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++idSeq + 100_000).padStart(12, "0")}` };

/** Everything a use case test needs, wired to fakes with a controllable clock. */
export function makeDeps(over: Partial<RewardsDeps> = {}) {
  const clock = new FakeClock();
  const store = new InMemoryRewardsStore();
  const ledger = new FakeLedger();
  const credit = new FakeStoreCredit(ledger);
  const plus = new FakePlusEntitlements();
  const vouchers = new FakeVouchers();
  const switches = new StaticRewardsSwitch(true, true);
  const approvals = new FakeApprovals();
  const deps: RewardsDeps = {
    store,
    ledger,
    credit,
    plus,
    vouchers,
    switches,
    attest: new FakeAttestation(),
    approvals,
    hash: new NodeHash(),
    random: new SequenceRandom(),
    clock,
    ids: seqIds,
    ...over,
  };
  return { deps, clock, store, ledger, credit, plus, vouchers, switches, approvals };
}

// ---- HTTP harness -----------------------------------------------------------------------------

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

const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });
const admin = (id: string, role: AdminRole): Actor => ({ id, status: "active", assurance: "passkey", grants: [{ kind: "admin", role }], tokenScopes: ["admin:access"] });

export const TOKENS = {
  s1: "token-shopper-1-0000000000001",
  s2: "token-shopper-2-0000000000002",
  marketing: "token-admin-marketing-0000003",
  support: "token-admin-support-000000004",
  shopperOnAdmin: "token-shopper-on-admin-aud-05",
  adminOnBuyer: "token-admin-on-buyer-aud-0006",
};
export const USERS = { s1: U(1), s2: U(2), marketing: U(31), support: U(32) };
export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

export interface RewardsHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly store: InMemoryRewardsStore;
  readonly ledger: FakeLedger;
  readonly credit: FakeStoreCredit;
  readonly vouchers: FakeVouchers;
  readonly switches: StaticRewardsSwitch;
  readonly approvals: FakeApprovals;
  readonly ingest: IngestRewardTrigger;
  readonly play: PlayGame;
  readonly odds: GetOdds;
  readonly publishOdds: PublishOdds;
  readonly sweep: SweepRewards;
  readonly tiers: TierService;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createRewardsHarness(): Promise<RewardsHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.s1, { actor: shopper(USERS.s1), aud: "buyer_api" });
  tokens.add(TOKENS.s2, { actor: shopper(USERS.s2), aud: "buyer_api" });
  tokens.add(TOKENS.marketing, { actor: admin(USERS.marketing, "marketing"), aud: "admin_api" });
  tokens.add(TOKENS.support, { actor: admin(USERS.support, "support"), aud: "admin_api" });
  tokens.add(TOKENS.shopperOnAdmin, { actor: shopper(USERS.s1), aud: "admin_api" });
  tokens.add(TOKENS.adminOnBuyer, { actor: admin(USERS.marketing, "marketing"), aud: "buyer_api" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const store = new InMemoryRewardsStore();
  const ledger = new FakeLedger();
  const credit = new FakeStoreCredit(ledger);
  const vouchers = new FakeVouchers();
  const switches = new StaticRewardsSwitch(false, true);
  const approvals = new FakeApprovals();

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      RewardsModule.forRoot(config, {
        store,
        ledger,
        credit,
        vouchers,
        switches,
        approvals,
        plus: new FakePlusEntitlements(),
        attest: new FakeAttestation(),
        hash: new NodeHash(),
        random: new SequenceRandom(),
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
    ledger,
    credit,
    vouchers,
    switches,
    approvals,
    ingest: get(T.INGEST_REWARD_TRIGGER),
    play: get(T.PLAY_GAME),
    odds: get(T.GET_ODDS),
    publishOdds: get(T.PUBLISH_ODDS),
    sweep: get(T.SWEEP_REWARDS),
    tiers: get(T.TIER_SERVICE),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}
