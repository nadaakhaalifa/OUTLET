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
  type Clock,
  type InMemoryAuditSink,
} from "../../../platform";
import { AdminModule } from "../admin.module";
import {
  InMemoryAdminAudit,
  InMemoryAdminStore,
  InMemoryFlagBackend,
  InMemoryPiiSource,
  InMemorySellerKyc,
  SPEC_KILL_SWITCH_KEYS,
} from "../adapters/in-memory";
import type { AdminRoleName } from "../domain/bridge";

export const START_MS = 1_800_000_000_000;

export class FakeClock implements Clock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

type Aud = "buyer_api" | "seller_api" | "admin_api";
export interface TestPrincipal {
  readonly token: string;
  readonly actor: Actor;
  readonly aud: Aud;
}

export const uid = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
const admin = (n: number, name: string, grants: Grant[], assurance: Actor["assurance"] = "passkey"): TestPrincipal => ({
  token: `admin-token-${name}-0001`,
  aud: "admin_api",
  actor: { id: uid(n), status: "active", assurance, grants, tokenScopes: [] },
});
const role = (r: AdminRoleName): Grant => ({ kind: "admin", role: r });

export const ROLE_PRINCIPALS = {
  ops: admin(11, "ops", [role("ops")]),
  finance: admin(12, "finance", [role("finance")]),
  trust_safety: admin(13, "trust-safety", [role("trust_safety")]),
  support: admin(14, "support", [role("support")]),
  marketing: admin(15, "marketing", [role("marketing")]),
  dpo: admin(16, "dpo", [role("dpo")]),
  security: admin(17, "security", [role("security")]),
  super_admin: admin(18, "super-admin", [role("super_admin")]),
} as const satisfies Record<AdminRoleName, TestPrincipal>;

export const PRINCIPALS = {
  ...ROLE_PRINCIPALS,
  finance2: admin(21, "finance2", [role("finance")]),
  ops2: admin(22, "ops2", [role("ops")]),
  trust_safety2: admin(23, "trust-safety2", [role("trust_safety")]),
  security2: admin(24, "security2", [role("security")]),
  super_admin2: admin(25, "super-admin2", [role("super_admin")]),
  opsNoPasskey: admin(31, "ops-nopasskey", [role("ops")], "basic"),
  opsExpired: admin(32, "ops-expired", [{ kind: "admin", role: "ops", expiresAtMs: 1 }]),
  /** Authenticates on the admin audience but holds no admin grant. */
  noGrants: admin(33, "no-grants", [{ kind: "shopper" }]),
  shopperOnBuyerAud: {
    token: "shopper-token-0001-xx",
    aud: "buyer_api" as const,
    actor: { id: uid(41), status: "active" as const, assurance: "passkey" as const, grants: [{ kind: "shopper" as const }], tokenScopes: [] },
  },
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

export interface AdminHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly config: AppConfig;
  readonly store: InMemoryAdminStore;
  readonly audit: InMemoryAdminAudit;
  readonly sink: InMemoryAuditSink;
  readonly kyc: InMemorySellerKyc;
  readonly pii: InMemoryPiiSource;
  readonly flags: InMemoryFlagBackend;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createAdminHarness(): Promise<AdminHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const store = new InMemoryAdminStore();
  const audit = new InMemoryAdminAudit();
  const kyc = new InMemorySellerKyc();
  const pii = new InMemoryPiiSource();
  const flags = new InMemoryFlagBackend([
    ...SPEC_KILL_SWITCH_KEYS.map((key) => ({ key, kind: "kill_switch" as const, description: key })),
    { key: "release.us_storefront_linkout", kind: "release" as const, description: "US link-out" },
  ]);
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      AdminModule.forRoot(config, { store, audit, kyc, pii, flags }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return {
    app,
    clock,
    config,
    store,
    audit,
    sink: app.get<InMemoryAuditSink>(AUDIT_SINK, { strict: false }),
    kyc,
    pii,
    flags,
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export const bearer = (p: TestPrincipal): Record<string, string> => ({ Authorization: `Bearer ${p.token}` });

let keySeq = 0;
export const idemKey = (): string => `0192f3a4-5b6c-7d8e-9f01-${String(900_000 + ++keySeq).padStart(12, "0")}`;
