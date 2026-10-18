import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, AdminRole } from "@outlet/policy";
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
import { InMemoryReconStore } from "../adapters/in-memory";
import { ReconciliationModule } from "../reconciliation.module";
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

export const adminActor = (
  id: string,
  role: AdminRole,
  o: Partial<Pick<Actor, "assurance" | "tokenScopes" | "status">> = {},
): Actor => ({
  id,
  status: o.status ?? "active",
  assurance: o.assurance ?? "passkey",
  grants: [{ kind: "admin", role }],
  tokenScopes: o.tokenScopes ?? ["admin:access"],
});

export const sellerActor = (id: string, storeId: string): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "brand", storeId, role: "finance" }],
  tokenScopes: ["seller:read", "seller:write"],
});

export const shopperActor = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });

export interface ReconHarness {
  readonly app: INestApplication;
  readonly clock: TestClock;
  readonly tokens: TokenTable;
  readonly store: InMemoryReconStore;
  readonly kit: Kit;
  readonly audit: InMemoryAuditSink;
  /** Flag `release.admin.finance_views`; OFF by default (blocked), as in production. */
  readonly financeViewsFlag: { on: boolean };
  /** Rail readiness the summary reports; empty means every rail is "unconfigured". */
  readonly railInputs: { value: Record<string, "configured" | "unconfigured"> };
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createReconHarness(): Promise<ReconHarness> {
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

  const store = new InMemoryReconStore();
  const financeViewsFlag = { on: false };
  const railInputs: { value: Record<string, "configured" | "unconfigured"> } = { value: {} };
  const k = kit(store, clock);
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      ReconciliationModule.forRoot(config, {
        store,
        clearing: k.clearing,
        eta: k.eta,
        integrity: k.integrity,
        alerts: k.alerts,
        flags: k.flags,
        financeViewsEnabled: () => financeViewsFlag.on,
        railInputs: () => railInputs.value,
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
    audit: app.get<InMemoryAuditSink>(AUDIT_SINK, { strict: false }),
    financeViewsFlag,
    railInputs,
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}
