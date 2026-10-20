import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, AdminRole, BrandRole } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator, type Clock } from "../../../platform";
import {
  FakeAgePolicy,
  FakeCardVault,
  FakeFlags,
  FakeLedger,
  FakeNotices,
  FakePersonKeys,
  FakePlanApprovals,
  FakeRecurringCharges,
  FakeRefunds,
  FakeTaxReceipts,
  HmacKeyHasher,
  InMemorySubscriptionStore,
} from "../adapters/in-memory";
import * as T from "../adapters/tokens";
import type { RunRenewalSweep } from "../application/sweeper";
import type { RecurringWebhookEvent, RecurringWebhookVerifierPort } from "../domain/ports";
import { SubscriptionsModule } from "../subscriptions.module";

export const START_MS = Date.UTC(2026, 3, 10, 9, 0, 0);
export const DAY = 86_400_000;

export class FakeClock implements Clock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

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
  async authenticate(bearerToken: string, nowMs: number) {
    const s = this.subjects.get(bearerToken);
    if (s === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    const claims: AccessClaims = {
      iss: "test",
      sub: s.actor.id,
      aud: s.aud,
      iat,
      exp: iat + 600,
      jti: `jti-${bearerToken}`,
      sid: `sid-${bearerToken}`,
      amr: ["otp_sms"],
    };
    return { actor: s.actor, claims };
  }
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let idemSeq = 0;
export const idem = (): Record<string, string> => ({
  "Idempotency-Key": `0192f3a4-5b6c-7d8e-9f01-${String(++idemSeq).padStart(12, "0")}`,
});
export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });
const seller = (id: string, storeId: string, role: BrandRole): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "brand", storeId, role }],
  tokenScopes: ["seller:read", "seller:write"],
});
const admin = (id: string, role: AdminRole): Actor => ({
  id,
  status: "active",
  assurance: "passkey",
  grants: [{ kind: "admin", role }],
  tokenScopes: ["admin:access"],
});

export const USERS = { a: U(1), b: U(2), young: U(3), noCard: U(4) };
export const TOKENS = {
  a: "token-plus-shopper-a-00000000001",
  b: "token-plus-shopper-b-00000000002",
  young: "token-plus-shopper-young-0000003",
  seller: "token-plus-seller-owner-0000000004",
  finance: "token-plus-admin-finance-00000005",
  support: "token-plus-admin-support-00000006",
  shopperOnAdminAud: "token-plus-shopper-on-admin-0007",
  adminOnBuyerAud: "token-plus-admin-on-buyer-000008",
};

/** Accepts `x-test-signature: ok` and a JSON body that is already a normalized event. */
export class ScriptedVerifier implements RecurringWebhookVerifierPort {
  async verify(i: { rawBody: Uint8Array; headers: Readonly<Record<string, string | undefined>> }) {
    if (i.headers["x-test-signature"] !== "ok") return { kind: "rejected" as const };
    const event = JSON.parse(Buffer.from(i.rawBody).toString("utf8")) as RecurringWebhookEvent;
    return { kind: "ok" as const, event };
  }
}

export interface PlusHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly store: InMemorySubscriptionStore;
  readonly ages: FakeAgePolicy;
  readonly charges: FakeRecurringCharges;
  readonly ledger: FakeLedger;
  readonly flags: FakeFlags;
  readonly approvals: FakePlanApprovals;
  readonly notices: FakeNotices;
  readonly sweep: RunRenewalSweep;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createPlusHarness(): Promise<PlusHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.a, { actor: shopper(USERS.a), aud: "buyer_api" });
  tokens.add(TOKENS.b, { actor: shopper(USERS.b), aud: "buyer_api" });
  tokens.add(TOKENS.young, { actor: shopper(USERS.young), aud: "buyer_api" });
  tokens.add(TOKENS.seller, { actor: seller(U(11), U(9001), "owner"), aud: "seller_api" });
  tokens.add(TOKENS.finance, { actor: admin(U(21), "finance"), aud: "admin_api" });
  tokens.add(TOKENS.support, { actor: admin(U(22), "support"), aud: "admin_api" });
  tokens.add(TOKENS.shopperOnAdminAud, { actor: shopper(USERS.a), aud: "admin_api" });
  tokens.add(TOKENS.adminOnBuyerAud, { actor: admin(U(21), "finance"), aud: "buyer_api" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const store = new InMemorySubscriptionStore();
  store.seedDefaultPlans(ids);
  const ages = new FakeAgePolicy();
  ages.setAge(USERS.a, 30);
  ages.setAge(USERS.b, 28);
  ages.setAge(USERS.young, 20);
  const persons = new FakePersonKeys();
  persons.set(USERS.a, "ph-a");
  persons.set(USERS.b, "ph-b");
  const vault = new FakeCardVault();
  vault.add(USERS.a, "tok_a", "fp-a");
  vault.add(USERS.b, "tok_b", "fp-b");
  vault.add(USERS.young, "tok_young", "fp-young");
  const charges = new FakeRecurringCharges();
  const ledger = new FakeLedger();
  const flags = new FakeFlags();
  const approvals = new FakePlanApprovals();
  const notices = new FakeNotices();

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      SubscriptionsModule.forRoot(config, {
        store,
        ages,
        persons,
        vault,
        charges,
        refunds: new FakeRefunds(),
        ledger,
        receipts: new FakeTaxReceipts(),
        notices,
        flags,
        approvals,
        hasher: new HmacKeyHasher("http-test"),
        webhookVerifier: new ScriptedVerifier(),
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  configureApp(app, config);
  await app.init();
  return {
    app,
    clock,
    store,
    ages,
    charges,
    ledger,
    flags,
    approvals,
    notices,
    sweep: app.get<RunRenewalSweep>(T.PLUS_RENEWAL_SWEEP, { strict: false }),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}
