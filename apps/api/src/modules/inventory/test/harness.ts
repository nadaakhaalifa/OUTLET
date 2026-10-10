import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, BrandRole } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import {
  AUTHENTICATOR,
  AUDIT_SINK,
  createIdGenerator,
  nodeCsprng,
  PlatformModule,
  type Authenticator,
  type Clock,
  type InMemoryAuditSink,
} from "../../../platform";
import { InventoryModule, type InventoryModuleOverrides } from "../index";
import { InMemoryInventoryStore, InMemorySkuDirectory } from "../adapters/in-memory";
import { INVENTORY_SKU_DIRECTORY, INVENTORY_STORE } from "../adapters/tokens";

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

interface TestSubject {
  readonly actor: Actor;
  readonly aud: AccessClaims["aud"];
}

/** Maps opaque bearer strings to prepared principals. No crypto: the real authenticator is the auth module's. */
export class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, TestSubject>();

  add(token: string, subject: TestSubject): string {
    if (token.length < 16) throw new Error("token fixture must be at least 16 chars");
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

export const shopperActor = (id: string): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "shopper" }],
  tokenScopes: [],
});

export interface InventoryHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly tokens: TokenTable;
  readonly store: InMemoryInventoryStore;
  readonly directory: InMemorySkuDirectory;
  readonly audit: InMemoryAuditSink;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createInventoryHarness(overrides: InventoryModuleOverrides = {}): Promise<InventoryHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return {
        module: TestAuthModule,
        providers: [{ provide: AUTHENTICATOR, useValue: tokens }],
        exports: [AUTHENTICATOR],
      };
    }
  }

  const store = new InMemoryInventoryStore(() => ids.uuidV7());
  const directory = new InMemorySkuDirectory();
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      InventoryModule.forRoot(config, { store: overrides.store ?? store, directory: overrides.directory ?? directory }),
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
    directory,
    audit: app.get<InMemoryAuditSink>(AUDIT_SINK, { strict: false }),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export { INVENTORY_SKU_DIRECTORY, INVENTORY_STORE };
