import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, BrandRole } from "@outlet/policy";
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
import { FakeStoreLookup, InMemoryOrderRepository } from "../adapters/in-memory";
import { OrdersModule } from "../orders.module";
import { kit, TestClock, type Kit } from "./fixtures";

interface TestSubject {
  readonly actor: Actor;
  readonly aud: AccessClaims["aud"];
}

/** Opaque bearer strings to prepared principals. No crypto: the real authenticator is the auth module's. */
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

export const shopperActor = (id: string): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "shopper" }],
  tokenScopes: [],
});

export interface OrdersHarness {
  readonly app: INestApplication;
  readonly clock: TestClock;
  readonly tokens: TokenTable;
  readonly repo: InMemoryOrderRepository;
  readonly stores: FakeStoreLookup;
  readonly kit: Kit;
  readonly audit: InMemoryAuditSink;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createOrdersHarness(): Promise<OrdersHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new TestClock();
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

  const repo = new InMemoryOrderRepository(clock, () => ids.uuidV7());
  const stores = new FakeStoreLookup();
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      OrdersModule.forRoot(config, { repository: repo, storeLookup: stores }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return {
    app,
    clock,
    tokens,
    repo,
    stores,
    kit: kit(repo, clock),
    audit: app.get<InMemoryAuditSink>(AUDIT_SINK, { strict: false }),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}
