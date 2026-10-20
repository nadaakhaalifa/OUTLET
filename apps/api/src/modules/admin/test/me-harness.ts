import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Actor, Grant } from "@outlet/policy";
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
import { AdminModule, type AdminIdentityModuleOptions } from "../admin.module";
import { InMemoryAdminStore } from "../adapters/in-memory";
import { InMemoryEdgeReplayStore } from "../adapters/edge-posture";
import type { AdminRoleName, ApprovalRecord, ElevationRecord } from "../domain/bridge";
import { FakeClock, uid } from "./harness";

export interface MeSubject {
  readonly token: string;
  readonly actor: Actor;
  readonly aud: "buyer_api" | "seller_api" | "admin_api";
  readonly amr: string[];
}

export function adminSubject(n: number, grants: Grant[], o: Partial<{ amr: string[]; assurance: Actor["assurance"]; scopes: string[]; aud: MeSubject["aud"] }> = {}): MeSubject {
  return {
    token: `me-token-${String(n).padStart(4, "0")}-xxxxxxxx`,
    aud: o.aud ?? "admin_api",
    amr: o.amr ?? ["passkey"],
    actor: { id: uid(n), status: "active", assurance: o.assurance ?? "passkey", grants, tokenScopes: o.scopes ?? ["admin:access"] },
  };
}
export const role = (r: AdminRoleName, expiresAtMs?: number): Grant =>
  expiresAtMs === undefined ? { kind: "admin", role: r } : { kind: "admin", role: r, expiresAtMs };

class Table implements Authenticator {
  readonly subjects = new Map<string, MeSubject>();
  async authenticate(token: string, nowMs: number) {
    const s = this.subjects.get(token);
    if (s === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    return {
      actor: s.actor,
      claims: { iss: "test", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `jti-${s.token}`, sid: `sid-${s.token}`, amr: s.amr as never },
    };
  }
}

@Global()
@Module({})
class AuthModule {
  static register(t: Table): DynamicModule {
    return { module: AuthModule, providers: [{ provide: AUTHENTICATOR, useValue: t }], exports: [AUTHENTICATOR] };
  }
}

export interface MeHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly store: InMemoryAdminStore;
  readonly sink: InMemoryAuditSink;
  readonly counts: string[];
  readonly replay: InMemoryEdgeReplayStore;
  add(s: MeSubject): MeSubject;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createMeHarness(identity: AdminIdentityModuleOptions = {}, env: Record<string, string> = {}): Promise<MeHarness> {
  const config = loadConfig({ NODE_ENV: "test", ...env });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const store = new InMemoryAdminStore();
  const table = new Table();
  const counts: string[] = [];
  const replay = new InMemoryEdgeReplayStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      AuthModule.register(table),
      AdminModule.forRoot(config, { store, identity: { enabled: () => true, replay, count: (o) => counts.push(o), ...identity } }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return {
    app,
    clock,
    store,
    sink: app.get<InMemoryAuditSink>(AUDIT_SINK, { strict: false }),
    counts,
    replay,
    add: (s) => {
      table.subjects.set(s.token, s);
      return s;
    },
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export const bearerOf = (s: MeSubject): Record<string, string> => ({ Authorization: `Bearer ${s.token}` });

export async function seedElevation(
  store: InMemoryAdminStore,
  userId: string,
  r: AdminRoleName,
  expiresAtMs: number,
  n = 1,
): Promise<ElevationRecord> {
  const approval: ApprovalRecord = {
    id: uid(6000 + n),
    kind: "role_grant",
    subjectType: "user",
    subjectId: userId,
    amountMinor: null,
    reasonCode: "incident_response",
    requesterId: userId,
    state: "APPROVED",
    approverId: uid(7000 + n),
    requestedAtMs: expiresAtMs - 3_600_000,
    expiresAtMs,
    decidedAtMs: expiresAtMs - 3_500_000,
    decisionNote: null,
  };
  const e: ElevationRecord = {
    id: uid(5000 + n),
    userId,
    role: r,
    reasonCode: "incident_response",
    approvalId: approval.id,
    requestedTtlMs: 3_600_000,
    state: "ACTIVE",
    requestedAtMs: expiresAtMs - 3_600_000,
    activatedAtMs: expiresAtMs - 3_500_000,
    expiresAtMs,
    revokedAtMs: null,
    revokedBy: null,
  };
  await store.createElevationWithApproval(approval, e);
  return e;
}
