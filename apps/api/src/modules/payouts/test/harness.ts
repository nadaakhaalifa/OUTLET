import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, AdminRole, BrandRole } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import {
  AUDIT_SINK,
  AUTHENTICATOR,
  PlatformModule,
  createIdGenerator,
  nodeCsprng,
  type Authenticator,
  type InMemoryAuditSink,
} from "../../../platform";
import { InMemoryPayoutStore } from "../adapters/in-memory";
import { PayoutsModule } from "../payouts.module";
import { kit, TestClock, type Kit } from "./fixtures";

interface TestSubject {
  readonly actor: Actor;
  readonly aud: AccessClaims["aud"];
}

export class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, TestSubject>();
  add(token: string, subject: TestSubject): string {
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

export const sellerActor = (
  id: string,
  storeId: string,
  role: BrandRole,
  overrides: Partial<Pick<Actor, "status" | "tokenScopes">> = {},
): Actor => ({
  id,
  status: overrides.status ?? "active",
  assurance: "basic",
  grants: [{ kind: "brand", storeId, role }],
  tokenScopes: overrides.tokenScopes ?? ["seller:read", "seller:write"],
});

export const adminActor = (
  id: string,
  role: AdminRole,
  overrides: Partial<Pick<Actor, "assurance" | "tokenScopes" | "status">> = {},
): Actor => ({
  id,
  status: overrides.status ?? "active",
  assurance: overrides.assurance ?? "passkey",
  grants: [{ kind: "admin", role }],
  tokenScopes: overrides.tokenScopes ?? ["admin:access"],
});

export const shopperActor = (id: string): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "shopper" }],
  tokenScopes: [],
});

export interface PayoutsHarness {
  readonly app: INestApplication;
  readonly clock: TestClock;
  readonly tokens: TokenTable;
  readonly store: InMemoryPayoutStore;
  readonly kit: Kit;
  readonly audit: InMemoryAuditSink;
  /** Flag `release.seller.balance`; on by default in this harness. */
  readonly balanceFlag: { on: boolean };
  /** Flag `release.admin.finance_views`; OFF by default here, as in production (blocked). */
  readonly financeViewsFlag: { on: boolean };
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createPayoutsHarness(): Promise<PayoutsHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new TestClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const balanceFlag = { on: true };
  const financeViewsFlag = { on: false };
  const store = new InMemoryPayoutStore(clock);
  const k = kit(store, clock);
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      PayoutsModule.forRoot(config, {
        store,
        source: k.source,
        statementSource: k.source,
        bank: k.bank,
        nameMatch: k.nameMatch,
        risk: k.risk,
        approvals: k.approvals,
        ledger: k.ledger,
        provider: k.provider,
        flags: k.flags,
        balance: { enabled: () => balanceFlag.on },
        financeViewsEnabled: () => financeViewsFlag.on,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return {
    app,
    clock,
    tokens,
    store,
    kit: k,
    balanceFlag,
    financeViewsFlag,
    audit: app.get<InMemoryAuditSink>(AUDIT_SINK, { strict: false }),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}
