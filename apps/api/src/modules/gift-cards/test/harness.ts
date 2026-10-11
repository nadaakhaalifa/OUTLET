import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator, type Clock } from "../../../platform";
import {
  DevAesGcmFieldCipher,
  FakeAgeGate,
  FakeAudit,
  FakeDelivery,
  FakeFlags,
  FakePayments,
  FakeSecret,
  FakeStoreCredit,
  InMemoryGiftCardStore,
  NodeRandom,
} from "../adapters/in-memory";
import { CancelUnpaidCard, ConfirmDelivered, ExpireGiftCards, IssueOnPayment, ListMyGiftCards, PurchaseGiftCard, VoidGiftCard } from "../application/purchase";
import {
  ClosePot,
  CloseDuePots,
  ConfirmContribution,
  ContributeToPot,
  CreateGiftPot,
  GetMyPot,
  GetSharedPot,
  RefundUnfundedPot,
} from "../application/pots";
import { RedeemGiftCard, ResumePendingRedemptions } from "../application/redeem";
import type { GiftCardDeps } from "../application/shared";
import { GiftCardsModule } from "../gift-cards.module";

export const START_MS = Date.parse("2026-04-15T09:00:00Z");
export const DAY = 86_400_000;
export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
export const EGP = (n: number): bigint => BigInt(n) * 100n;

export class FakeClock implements Clock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export function createRuntime() {
  const clock = new FakeClock();
  let n = 0;
  const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}` };
  const store = new InMemoryGiftCardStore();
  const secret = new FakeSecret();
  const random = new NodeRandom();
  const cipher = new DevAesGcmFieldCipher();
  const storeCredit = new FakeStoreCredit();
  const audit = new FakeAudit();
  const flags = new FakeFlags();
  const age = new FakeAgeGate();
  const payments = new FakePayments();
  const delivery = new FakeDelivery();
  const d: GiftCardDeps = { store, clock, ids, secret, random, cipher, storeCredit, audit, flags, age, payments, delivery };
  const close = new ClosePot(d);
  const refund = new RefundUnfundedPot(d);
  return {
    d,
    clock,
    store,
    secret,
    storeCredit,
    audit,
    flags,
    age,
    payments,
    delivery,
    cipher,
    random,
    purchase: new PurchaseGiftCard(d),
    issue: new IssueOnPayment(d),
    cancel: new CancelUnpaidCard(d),
    delivered: new ConfirmDelivered(d),
    redeem: new RedeemGiftCard(d),
    resume: new ResumePendingRedemptions(d),
    voidCard: new VoidGiftCard(d),
    list: new ListMyGiftCards(d),
    expire: new ExpireGiftCards(d),
    createPot: new CreateGiftPot(d),
    contribute: new ContributeToPot(d),
    confirm: new ConfirmContribution(d, close),
    close,
    refund,
    due: new CloseDuePots(d, close, refund),
    shared: new GetSharedPot(d),
    myPot: new GetMyPot(d),
  };
}
export type Runtime = ReturnType<typeof createRuntime>;

interface Subject {
  readonly actor: Actor;
  readonly aud: AccessClaims["aud"];
}

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
    const claims: AccessClaims = { iss: "test", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `jti-${bearer}`, sid: `sid-${bearer}`, amr: ["otp_sms"] };
    return { actor: s.actor, claims };
  }
}

export const TOKENS = {
  a: "token-shopper-a-000000000000001",
  b: "token-shopper-b-000000000000002",
  seller: "token-seller-owner-0000000000003",
  admin: "token-admin-support-000000000004",
};
const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });

export interface GiftCardHarness {
  readonly app: INestApplication;
  readonly rt: Runtime;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createGiftCardHarness(): Promise<GiftCardHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const rt = createRuntime();
  const ids = createIdGenerator(rt.clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.a, { actor: shopper(U(1)), aud: "buyer_api" });
  tokens.add(TOKENS.b, { actor: shopper(U(2)), aud: "buyer_api" });
  tokens.add(TOKENS.seller, {
    actor: { id: U(11), status: "active", assurance: "basic", grants: [{ kind: "brand", storeId: U(9001), role: "owner" }], tokenScopes: ["seller:read", "seller:write"] },
    aud: "seller_api",
  });
  tokens.add(TOKENS.admin, {
    actor: { id: U(21), status: "active", assurance: "passkey", grants: [{ kind: "admin", role: "support" }], tokenScopes: ["admin:access"] },
    aud: "admin_api",
  });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock: rt.clock, ids }),
      TestAuthModule.register(),
      GiftCardsModule.forRoot(config, {
        store: rt.store,
        secret: rt.secret,
        random: rt.random,
        cipher: rt.cipher,
        storeCredit: rt.storeCredit,
        audit: rt.audit,
        flags: rt.flags,
        age: rt.age,
        payments: rt.payments,
        delivery: rt.delivery,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, rt, http: () => request(app.getHttpServer()), close: () => app.close() };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
