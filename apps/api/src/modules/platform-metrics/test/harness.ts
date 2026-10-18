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
  type Clock,
  type InMemoryAuditSink,
} from "../../../platform";
import { InMemoryPlatformRollups } from "../adapters/in-memory";
import { PlatformMetricsModule } from "../platform-metrics.module";

export const NOW = Date.parse("2026-10-20T12:00:00Z");
export class FakeClock implements Clock {
  constructor(private ms = NOW) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface Subject {
  readonly token: string;
  readonly actor: Actor;
  readonly aud: "buyer_api" | "seller_api" | "admin_api";
}
export const uid = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
export const subject = (n: number, grants: Grant[], o: Partial<{ aud: Subject["aud"]; assurance: Actor["assurance"] }> = {}): Subject => ({
  token: `pm-token-${String(n).padStart(4, "0")}-xxxxxxxxxxxx`,
  aud: o.aud ?? "admin_api",
  actor: { id: uid(n), status: "active", assurance: o.assurance ?? "passkey", grants, tokenScopes: ["admin:access"] },
});
export const adminRole = (role: Extract<Grant, { kind: "admin" }>["role"]): Grant => ({ kind: "admin", role });
export const bearer = (s: Subject): Record<string, string> => ({ Authorization: `Bearer ${s.token}` });

class Table implements Authenticator {
  readonly m = new Map<string, Subject>();
  async authenticate(token: string, nowMs: number) {
    const s = this.m.get(token);
    if (s === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    return { actor: s.actor, claims: { iss: "t", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `j-${s.token}`, sid: `s-${s.token}`, amr: ["passkey" as const] } };
  }
}
@Global()
@Module({})
class AuthModule {
  static register(t: Table): DynamicModule {
    return { module: AuthModule, providers: [{ provide: AUTHENTICATOR, useValue: t }], exports: [AUTHENTICATOR] };
  }
}

export interface Harness {
  readonly app: INestApplication;
  readonly rollups: InMemoryPlatformRollups;
  readonly sink: InMemoryAuditSink;
  readonly reads: string[];
  readonly elevations: Map<string, readonly never[]>;
  readonly fail: { elevations: boolean };
  add(s: Subject): Subject;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createHarness(enabled = true): Promise<Harness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const rollups = new InMemoryPlatformRollups();
  const reads: string[] = [];
  const table = new Table();
  const fail = { elevations: false };
  const elevations = new Map<string, readonly never[]>();
  const ref = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      AuthModule.register(table),
      PlatformMetricsModule.forRoot(config, {
        reader: rollups,
        elevations: { liveElevations: async (id) => {
            if (fail.elevations) throw new Error("db down");
            return elevations.get(id) ?? [];
          } },
        enabled: () => enabled,
        countRead: (m) => reads.push(m),
      }),
    ],
  }).compile();
  const app = ref.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return {
    app,
    rollups,
    reads,
    elevations,
    fail,
    sink: app.get<InMemoryAuditSink>(AUDIT_SINK, { strict: false }),
    add: (s) => (table.m.set(s.token, s), s),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}
