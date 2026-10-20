import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, type Authenticator } from "../../../platform";
import { StaticPaymentRegistry } from "../adapters/fakes";
import { CheckoutModule } from "../checkout.module";
import { createWorld, type World, type WorldOptions } from "./world";

export class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, Actor>();
  add(token: string, actor: Actor): string {
    this.subjects.set(token, actor);
    return token;
  }
  async authenticate(bearer: string, nowMs: number) {
    const actor = this.subjects.get(bearer);
    if (actor === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    const claims: AccessClaims = {
      iss: "test",
      sub: actor.id,
      aud: "buyer_api",
      iat,
      exp: iat + 600,
      jti: `jti-${bearer}`,
      sid: `sid-${bearer}`,
      amr: ["otp_sms"],
    };
    return { actor, claims };
  }
}

export const shopperActor = (id: string): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "shopper" }],
  tokenScopes: [],
});

export interface CheckoutHarness {
  readonly app: INestApplication;
  readonly world: World;
  readonly tokens: TokenTable;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createCheckoutHarness(opts: WorldOptions = {}): Promise<CheckoutHarness> {
  const world = createWorld(opts);
  const config = loadConfig({ NODE_ENV: "test" });
  const tokens = new TokenTable();

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock: world.clock, ids: world.ids }),
      TestAuthModule.register(),
      CheckoutModule.forRoot(config, {
        repository: world.repo,
        cart: world.cart,
        inventory: world.inventory,
        credit: world.credit,
        payments: new StaticPaymentRegistry([world.provider]),
        ledger: world.ledger,
        orders: world.orders,
        risk: world.risk,
        agePolicy: world.agePolicy,
        killSwitch: world.killSwitch,
        addresses: world.addresses,
        metrics: world.metrics,
        lockSecret: "http-test-secret",
        requireAppAttest: opts.requireAppAttest ?? false,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  configureApp(app, config);
  await app.init();
  return { app, world, tokens, http: () => request(app.getHttpServer()), close: () => app.close() };
}
