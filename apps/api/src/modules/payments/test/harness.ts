import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator } from "../../../platform";
import { FakePaymentProvider } from "../adapters/fake-provider";
import { StaticPaymentMethodSwitch } from "../adapters/flag-switch";
import { InMemoryPaymentStore } from "../adapters/in-memory-store";
import { PAYMENT_PROCESS_WEBHOOK } from "../adapters/tokens";
import type { ProcessPaymentWebhook } from "../application/payments";
import type { WebhookIpAllowListPort } from "../domain/ports";
import { PaymentsModule } from "../payments.module";
import { TestClock } from "./fixtures";

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

export const shopperActor = (id: string): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "shopper" }],
  tokenScopes: [],
});

export interface HarnessOptions {
  readonly rawBody?: boolean;
  readonly ipAllowList?: WebhookIpAllowListPort;
}

export async function createPaymentsHarness(opts: HarnessOptions = {}) {
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

  const store = new InMemoryPaymentStore(clock, () => ids.uuidV7());
  const provider = new FakePaymentProvider("fake_psp", "http-secret-not-real", undefined, () => clock.nowMs());
  const sw = new StaticPaymentMethodSwitch();
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      PaymentsModule.forRoot(config, {
        store,
        providers: [provider],
        methodSwitch: sw,
        ...(opts.ipAllowList !== undefined ? { ipAllowList: opts.ipAllowList } : {}),
      }),
    ],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: false, rawBody: opts.rawBody ?? true });
  configureApp(app, config);
  await app.init();
  return {
    app,
    clock,
    tokens,
    store,
    provider,
    sw,
    processor: app.get<ProcessPaymentWebhook>(PAYMENT_PROCESS_WEBHOOK),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}
