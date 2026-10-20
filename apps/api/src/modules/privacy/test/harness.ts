import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Actor, Grant } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig, type AppConfig } from "../../../config/env";
import {
  AUDIT_SINK,
  AUTHENTICATOR,
  PlatformModule,
  createIdGenerator,
  nodeCsprng,
  type Authenticator,
  type InMemoryAuditSink,
} from "../../../platform";
import { FakeBlockers, RecordingErasureExecutor } from "../adapters/in-memory";
import { PrivacyModule, type PrivacyModuleOptions } from "../privacy.module";
import { FakeClock, loadInventoryTables } from "./fixtures";

type Aud = "buyer_api" | "seller_api" | "admin_api";

export interface TestPrincipal {
  readonly token: string;
  readonly actor: Actor;
  readonly aud: Aud;
}

const uid = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
const shopper = (n: number, token: string): TestPrincipal => ({
  token,
  aud: "buyer_api",
  actor: { id: uid(n), status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] },
});
const admin = (n: number, token: string, grants: Grant[], assurance: Actor["assurance"] = "passkey"): TestPrincipal => ({
  token,
  aud: "admin_api",
  actor: { id: uid(n), status: "active", assurance, grants, tokenScopes: [] },
});

export const PRINCIPALS = {
  alice: shopper(1, "shopper-token-alice-0001"),
  bob: shopper(2, "shopper-token-bob-000001"),
  dpo: admin(11, "admin-token-dpo-0000001", [{ kind: "admin", role: "dpo" }]),
  dpoNoPasskey: admin(12, "admin-token-dpo-nopasskey", [{ kind: "admin", role: "dpo" }], "basic"),
  dpoExpired: admin(13, "admin-token-dpo-expired01", [{ kind: "admin", role: "dpo", expiresAtMs: 1 }]),
  ops: admin(14, "admin-token-ops-0000001", [{ kind: "admin", role: "ops" }]),
  /** A shopper actor presenting an admin-audience token (misissued): has no admin grant at all. */
  shopperOnAdminAud: { ...shopper(3, "shopper-token-on-admin-01"), aud: "admin_api" as const },
} as const;

class TestAuthenticator implements Authenticator {
  private readonly byToken = new Map<string, TestPrincipal>(Object.values(PRINCIPALS).map((p) => [p.token, p]));
  async authenticate(token: string, nowMs: number) {
    const p = this.byToken.get(token);
    if (p === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    return {
      actor: p.actor,
      claims: { iss: "test", sub: p.actor.id, aud: p.aud, iat, exp: iat + 600, jti: `jti-${p.actor.id}`, sid: `sid-${p.actor.id}`, amr: ["otp_sms" as const] },
    };
  }
}

@Global()
@Module({})
class TestAuthModule {
  static register(): DynamicModule {
    return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: new TestAuthenticator() }], exports: [AUTHENTICATOR] };
  }
}

export interface PrivacyHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly config: AppConfig;
  readonly blockers: FakeBlockers;
  readonly executor: RecordingErasureExecutor;
  readonly audit: InMemoryAuditSink;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createPrivacyHarness(extra: PrivacyModuleOptions = {}): Promise<PrivacyHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const blockers = new FakeBlockers();
  const executor = new RecordingErasureExecutor();
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      PrivacyModule.forRoot(config, {
        blockers,
        erasureExecutor: executor,
        inventory: loadInventoryTables(),
        pseudonymKey: new Uint8Array(32).fill(9),
        ...extra,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return {
    app,
    clock,
    config,
    blockers,
    executor,
    audit: app.get<InMemoryAuditSink>(AUDIT_SINK, { strict: false }),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export const bearer = (p: TestPrincipal): Record<string, string> => ({ Authorization: `Bearer ${p.token}` });
