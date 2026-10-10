import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Actor, Grant } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig, type AppConfig } from "../../../config/env";
import {
  AUTHENTICATOR,
  PlatformModule,
  createIdGenerator,
  nodeCsprng,
  type Authenticator,
  type Clock,
  type IdGenerator,
} from "../../../platform";
import { FulfillmentModule } from "../fulfillment.module";
import { BostaStyleWebhookAdapter, signBostaWebhook } from "../adapters/bosta/bosta-adapter";
import { FakeBostaCourier } from "../adapters/bosta/fake-bosta";
import {
  FakeSellerOrders,
  InMemoryFulfillmentMetrics,
  InMemoryFulfillmentRepository,
  StaticCourierSecrets,
} from "../adapters/in-memory";
import { AWB_WORKER, INGEST_COURIER_WEBHOOK } from "../adapters/tokens";
import type { AwbWorker } from "../application/awb-worker";
import type { IngestCourierWebhook } from "../application/webhooks";
import { money } from "../domain/bridge";
import type { FulfillmentRepository, SellerOrderFacts } from "../domain/ports";

export const START_MS = 1_800_000_000_000;

export class TestClock implements Clock {
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
export const STORE_A = uid(9001);
export const STORE_B = uid(9002);
export const WEBHOOK_SECRET = "whsec_test_current_0123456789";
export const OLD_WEBHOOK_SECRET = "whsec_test_previous_9876543210";

function seller(n: number, token: string, grants: Grant[], extra: Partial<Actor> = {}): TestPrincipal {
  return {
    token,
    aud: "seller_api",
    actor: { id: uid(n), status: "active", assurance: "basic", grants, tokenScopes: ["seller:read", "seller:write"], ...extra },
  };
}

export const PRINCIPALS = {
  buyer: {
    token: "buyer-token-0000000001",
    aud: "buyer_api",
    actor: { id: uid(1), status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] },
  } satisfies TestPrincipal,
  ownerA: seller(11, "seller-token-owner-a-01", [{ kind: "brand", storeId: STORE_A, role: "owner" }]),
  warehouseA: seller(14, "seller-token-wareh-a-01", [{ kind: "brand", storeId: STORE_A, role: "warehouse" }]),
  supportA: seller(13, "seller-token-support-a1", [{ kind: "brand", storeId: STORE_A, role: "support" }]),
  catalogA: seller(12, "seller-token-catalog-a1", [{ kind: "brand", storeId: STORE_A, role: "catalog" }]),
  ownerB: seller(21, "seller-token-owner-b-01", [{ kind: "brand", storeId: STORE_B, role: "owner" }]),
  noGrants: seller(41, "seller-token-nogrant-01", []),
  suspendedA: seller(51, "seller-token-suspend-01", [{ kind: "brand", storeId: STORE_A, role: "owner" }], { status: "suspended" }),
  readOnlyA: seller(61, "seller-token-readonly-01", [{ kind: "brand", storeId: STORE_A, role: "owner" }], { tokenScopes: ["seller:read"] }),
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
    return {
      module: TestAuthModule,
      providers: [{ provide: AUTHENTICATOR, useValue: new TestAuthenticator() }],
      exports: [AUTHENTICATOR],
    };
  }
}

export interface FulfillmentHarness {
  readonly app: INestApplication;
  readonly clock: TestClock;
  readonly config: AppConfig;
  readonly repo: InMemoryFulfillmentRepository;
  readonly courier: FakeBostaCourier;
  readonly orders: FakeSellerOrders;
  readonly metrics: InMemoryFulfillmentMetrics;
  readonly worker: AwbWorker;
  readonly ingest: IngestCourierWebhook;
  readonly ids: IdGenerator;
  http(): ReturnType<typeof request>;
  /** Sends a signed courier webhook. `raw` overrides the body that is sent after signing. */
  webhook(
    body: object,
    opts?: { secret?: string; timestampSeconds?: number; signature?: string; raw?: string; courier?: string },
  ): ReturnType<ReturnType<typeof request>["post"]>;
  close(): Promise<void>;
}

export async function createFulfillmentHarness(
  options: { repository?: FulfillmentRepository } = {},
): Promise<FulfillmentHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new TestClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const repo = new InMemoryFulfillmentRepository();
  const courier = new FakeBostaCourier();
  const orders = new FakeSellerOrders();
  const metrics = new InMemoryFulfillmentMetrics();
  const secrets = new StaticCourierSecrets({ bosta: [WEBHOOK_SECRET, OLD_WEBHOOK_SECRET] });
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      FulfillmentModule.forRoot(config, {
        repository: options.repository ?? repo,
        orders,
        secrets,
        metrics,
        couriers: [{ port: courier, webhook: new BostaStyleWebhookAdapter() }],
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  configureApp(app, config);
  await app.init();
  const http = () => request(app.getHttpServer());
  return {
    app,
    clock,
    config,
    repo,
    courier,
    orders,
    metrics,
    ids,
    worker: app.get<AwbWorker>(AWB_WORKER, { strict: false }),
    ingest: app.get<IngestCourierWebhook>(INGEST_COURIER_WEBHOOK, { strict: false }),
    http,
    webhook: (body, opts = {}) => {
      const raw = opts.raw ?? JSON.stringify(body);
      const ts = opts.timestampSeconds ?? Math.floor(clock.nowMs() / 1000);
      const signedRaw = JSON.stringify(body);
      const sig = opts.signature ?? signBostaWebhook(opts.secret ?? WEBHOOK_SECRET, ts, signedRaw);
      return http()
        .post(`/v1/webhooks/couriers/${opts.courier ?? "bosta"}`)
        .set("content-type", "application/json")
        .set("x-signature", sig)
        .set("x-timestamp", String(ts))
        .send(raw);
    },
    close: () => app.close(),
  };
}

let idemCounter = 0;
export function idemKey(): string {
  idemCounter += 1;
  return `0192f3a4-5b6c-7d8e-9f01-${String(700_000_000_000 + idemCounter).padStart(12, "0")}`;
}

export const bearer = (p: TestPrincipal | string): Record<string, string> => ({
  Authorization: `Bearer ${typeof p === "string" ? p : p.token}`,
});

export function sellerOrder(n: number, storeId: string, over: Partial<SellerOrderFacts> = {}): SellerOrderFacts {
  return {
    id: uid(3000 + n),
    storeId,
    status: "PACKED",
    codAmount: null,
    recipient: { name: "Test Consignee", phone: "+201001234567", governorate: "Cairo", city: "Nasr City", addressLine: "12 Test St" },
    pickup: { label: "Warehouse", governorate: "Cairo", city: "Obour", addressLine: "Industrial Zone 4" },
    ...over,
  };
}

export const codOrder = (n: number, storeId: string, piastres: bigint): SellerOrderFacts =>
  sellerOrder(n, storeId, { codAmount: money(piastres) });

/** A Bosta-style tracking webhook body (assumed shape, see adapters/bosta/fixtures). */
export function trackingBody(
  eventId: string,
  awb: string,
  state: string,
  atMs: number,
  exceptionReason: string | null = null,
) {
  return {
    event: "delivery.state_changed",
    id: eventId,
    trackingNumber: awb,
    state: { code: 0, value: state },
    timestamp: Math.floor(atMs / 1000),
    exceptionReason,
  };
}

export function remittanceBody(
  eventId: string,
  cashRef: string,
  lines: readonly { awb: string; collected: number; fee?: number }[],
) {
  return {
    event: "cod.remitted",
    id: eventId,
    cashRef,
    date: "2026-10-12",
    deliveries: lines.map((l) => ({ trackingNumber: l.awb, collected: l.collected, fee: l.fee ?? 0 })),
  };
}
