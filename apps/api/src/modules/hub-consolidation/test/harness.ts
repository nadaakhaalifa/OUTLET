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
  FakeHubLedger,
  FakeOutboundCourier,
  FakeParcelFacts,
  InMemoryHubStore,
  StaticHubFlags,
} from "../adapters/in-memory";
import * as T from "../adapters/tokens";
import type { DispatchHubParcel, EvaluateHubGroup, OpenHubGroup, SweepHubGroups } from "../application/hub";
import { HubConsolidationModule } from "../hub-consolidation.module";

export const START_MS = 1_800_000_000_000;
export const HOUR = 3_600_000;
export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
export const HUB_1 = U(100);
export const HUB_2 = U(101);

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
  add(token: string, subject: { actor: Actor; aud: AccessClaims["aud"] }): void {
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
const operator = (id: string, hubId: string): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "courier", hubId }],
  tokenScopes: [],
});
const admin = (id: string, role: AdminRole): Actor => ({
  id,
  status: "active",
  assurance: "passkey",
  grants: [{ kind: "admin", role }],
  tokenScopes: ["admin:access"],
});

export const TOKENS = {
  shopper1: "token-hub-shopper-1-0000000001",
  shopper2: "token-hub-shopper-2-0000000002",
  opHub1: "token-hub-operator-1-000000003",
  opHub2: "token-hub-operator-2-000000004",
  adminSupport: "token-hub-admin-support-00005",
  shopperOnAdminAud: "token-hub-shopper-admin-aud-06",
  operatorOnBuyerAud: "token-hub-operator-buyer-aud-07",
};
export const USERS = { shopper1: U(1), shopper2: U(2), opHub1: U(11), opHub2: U(12) };

export interface HubHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly store: InMemoryHubStore;
  readonly flags: StaticHubFlags;
  readonly outbound: FakeOutboundCourier;
  readonly ledger: FakeHubLedger;
  readonly open: OpenHubGroup;
  readonly evaluate: EvaluateHubGroup;
  readonly sweep: SweepHubGroups;
  readonly dispatch: DispatchHubParcel;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createHubHarness(): Promise<HubHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.shopper1, { actor: shopper(USERS.shopper1), aud: "buyer_api" });
  tokens.add(TOKENS.shopper2, { actor: shopper(USERS.shopper2), aud: "buyer_api" });
  tokens.add(TOKENS.opHub1, { actor: operator(USERS.opHub1, HUB_1), aud: "admin_api" });
  tokens.add(TOKENS.opHub2, { actor: operator(USERS.opHub2, HUB_2), aud: "admin_api" });
  tokens.add(TOKENS.adminSupport, { actor: admin(U(21), "support"), aud: "admin_api" });
  tokens.add(TOKENS.shopperOnAdminAud, { actor: shopper(USERS.shopper1), aud: "admin_api" });
  tokens.add(TOKENS.operatorOnBuyerAud, { actor: operator(USERS.opHub1, HUB_1), aud: "buyer_api" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const store = new InMemoryHubStore();
  const flags = new StaticHubFlags(true);
  const outbound = new FakeOutboundCourier();
  const ledger = new FakeHubLedger();
  await store.upsertHub({ id: HUB_1, name: "Cairo hub", governorate: "Cairo" });
  await store.upsertHub({ id: HUB_2, name: "Alex hub", governorate: "Alexandria" });

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      HubConsolidationModule.forRoot(config, { store, flags, outbound, ledger, facts: new FakeParcelFacts() }),
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
    flags,
    outbound,
    ledger,
    open: get(T.OPEN_HUB_GROUP),
    evaluate: get(T.EVALUATE_HUB_GROUP),
    sweep: get(T.SWEEP_HUB_GROUPS),
    dispatch: get(T.DISPATCH_HUB_PARCEL),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
