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
  type Clock,
  type InMemoryAuditSink,
} from "../../../platform";
import { money } from "../domain/bridge";
import type { ReturnableLine } from "../domain/ports";
import {
  FakeEvidence,
  FakeExchangeStock,
  FakeReturnableLines,
  InMemoryReturnEventPublisher,
  InMemoryReturnRepository,
  StaticReturnerHistory,
  StaticReturnsMembership,
} from "../adapters/in-memory";
import { ReturnsModule } from "../returns.module";
import * as T from "../adapters/tokens";
import type {
  AutoApproveOverdueInspections,
  CloseElapsedDisputeWindows,
  CompleteReturnExchange,
  CompleteReturnRefund,
  PublishPendingIntents,
  RecordReturnPickedUp,
  RecordReturnReceived,
  ResolveReturnDispute,
  ScheduleReturnPickup,
} from "../application/returns";

export const START_MS = 1_800_000_000_000;
export const DAY = 86_400_000;

export class FakeClock implements Clock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}

interface Subject {
  readonly actor: Actor;
  readonly aud: AccessClaims["aud"];
}

/** Opaque bearer strings to prepared principals. No crypto: the real authenticator is the auth module's. */
export class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, Subject>();
  add(token: string, subject: Subject): string {
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

export const shopperActor = (id: string, status: Actor["status"] = "active"): Actor => ({
  id,
  status,
  assurance: "basic",
  grants: [{ kind: "shopper" }],
  tokenScopes: [],
});

export const sellerActor = (
  id: string,
  storeId: string,
  role: BrandRole,
  o: Partial<Pick<Actor, "status" | "tokenScopes">> = {},
): Actor => ({
  id,
  status: o.status ?? "active",
  assurance: "basic",
  grants: [{ kind: "brand", storeId, role }],
  tokenScopes: o.tokenScopes ?? ["seller:read", "seller:write"],
});

/** Deterministic ids. */
export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;

export const STORE_A = U(9001);
export const STORE_B = U(9002);
export const SHOPPER_1 = U(1);
export const SHOPPER_2 = U(2);

export const line = (n: number, o: Partial<ReturnableLine> = {}): ReturnableLine => ({
  orderLineId: U(500 + n),
  sellerOrderId: U(600 + n),
  storeId: STORE_A,
  userId: SHOPPER_1,
  qtyOrdered: 2,
  unitPrice: money(50_000n),
  discountAlloc: money(5_000n),
  deliveryFeeAlloc: money(6_000n),
  deliveredAtMs: START_MS - DAY,
  returnClass: "standard",
  otherLinesOpenQty: 0,
  ...o,
});

export interface ReturnsHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly tokens: TokenTable;
  readonly repo: InMemoryReturnRepository;
  readonly lines: FakeReturnableLines;
  readonly membership: StaticReturnsMembership;
  readonly history: StaticReturnerHistory;
  readonly evidence: FakeEvidence;
  readonly exchangeStock: FakeExchangeStock;
  readonly events: InMemoryReturnEventPublisher;
  readonly audit: InMemoryAuditSink;
  readonly schedulePickup: ScheduleReturnPickup;
  readonly pickedUp: RecordReturnPickedUp;
  readonly received: RecordReturnReceived;
  readonly autoApprove: AutoApproveOverdueInspections;
  readonly closeWindows: CloseElapsedDisputeWindows;
  readonly resolveDispute: ResolveReturnDispute;
  readonly completeRefund: CompleteReturnRefund;
  readonly completeExchange: CompleteReturnExchange;
  readonly publishPending: PublishPendingIntents;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export const TOKENS = {
  shopper1: "token-shopper-one-00000001",
  shopper2: "token-shopper-two-00000002",
  suspended: "token-shopper-suspended-03",
  ownerA: "token-seller-owner-a-0000004",
  warehouseA: "token-seller-warehouse-a-005",
  supportA: "token-seller-support-a-00006",
  catalogA: "token-seller-catalog-a-00007",
  noScopeA: "token-seller-noscope-a-00008",
  ownerB: "token-seller-owner-b-0000009",
  suspendedSeller: "token-seller-suspended-a-0012",
  buyerAudSeller: "token-seller-on-buyer-aud-10",
  sellerAudShopper: "token-shopper-on-seller-aud-11",
};

export async function createReturnsHarness(): Promise<ReturnsHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.shopper1, { actor: shopperActor(SHOPPER_1), aud: "buyer_api" });
  tokens.add(TOKENS.shopper2, { actor: shopperActor(SHOPPER_2), aud: "buyer_api" });
  tokens.add(TOKENS.suspended, { actor: shopperActor(U(3), "suspended"), aud: "buyer_api" });
  tokens.add(TOKENS.ownerA, { actor: sellerActor(U(11), STORE_A, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.warehouseA, { actor: sellerActor(U(12), STORE_A, "warehouse"), aud: "seller_api" });
  tokens.add(TOKENS.supportA, { actor: sellerActor(U(13), STORE_A, "support"), aud: "seller_api" });
  tokens.add(TOKENS.catalogA, { actor: sellerActor(U(14), STORE_A, "catalog"), aud: "seller_api" });
  tokens.add(TOKENS.noScopeA, { actor: sellerActor(U(15), STORE_A, "owner", { tokenScopes: ["seller:read"] }), aud: "seller_api" });
  tokens.add(TOKENS.ownerB, { actor: sellerActor(U(16), STORE_B, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.suspendedSeller, { actor: sellerActor(U(17), STORE_A, "owner", { status: "suspended" }), aud: "seller_api" });
  tokens.add(TOKENS.buyerAudSeller, { actor: sellerActor(U(11), STORE_A, "owner"), aud: "buyer_api" });
  tokens.add(TOKENS.sellerAudShopper, { actor: shopperActor(SHOPPER_1), aud: "seller_api" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const repo = new InMemoryReturnRepository();
  const lines = new FakeReturnableLines();
  const membership = new StaticReturnsMembership();
  const history = new StaticReturnerHistory();
  const evidence = new FakeEvidence();
  const exchangeStock = new FakeExchangeStock();
  const events = new InMemoryReturnEventPublisher();
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      ReturnsModule.forRoot(config, { repository: repo, lines, membership, history, evidence, exchangeStock, events }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  const get = <X>(token: symbol): X => app.get<X>(token, { strict: false });
  return {
    app,
    clock,
    tokens,
    repo,
    lines,
    membership,
    history,
    evidence,
    exchangeStock,
    events,
    audit: get<InMemoryAuditSink>(AUDIT_SINK),
    schedulePickup: get(T.SCHEDULE_RETURN_PICKUP),
    pickedUp: get(T.RECORD_RETURN_PICKED_UP),
    received: get(T.RECORD_RETURN_RECEIVED),
    autoApprove: get(T.AUTO_APPROVE_OVERDUE),
    closeWindows: get(T.CLOSE_ELAPSED_DISPUTES),
    resolveDispute: get(T.RESOLVE_RETURN_DISPUTE),
    completeRefund: get(T.COMPLETE_RETURN_REFUND),
    completeExchange: get(T.COMPLETE_RETURN_EXCHANGE),
    publishPending: get(T.PUBLISH_PENDING_INTENTS),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
