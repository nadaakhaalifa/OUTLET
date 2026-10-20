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
  FakeBagTotal,
  FakeBudgetConsent,
  FakeBudgetFlags,
  FakeOrderSpendSource,
  FakeWishlistPlanSource,
  InMemoryBudgetStore,
} from "../adapters/in-memory";
import * as T from "../adapters/tokens";
import { AffordabilityFilter, PlanMyPurchases } from "../application/affordability";
import { DeleteBudget, GetSummary, SetBudget } from "../application/budget";
import { CheckoutCapGuard, RequestCapUnlock } from "../application/caps";
import { BudgetCodec } from "../application/codec";
import { ExportBudgetData, PurgeUserBudget, RollCycles } from "../application/lifecycle";
import type { BudgetDeps } from "../application/shared";
import { IngestProviderCommitments, ReconcileSpend, RecordSpend } from "../application/spend";
import type { SpendEvent } from "../domain/bridge";
import { BudgetModule } from "../budget.module";

/** 2026-04-15 12:00 Cairo-ish; payday 25 cycles run Mar 25 to Apr 25. */
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
  set(ms: number): void {
    this.ms = ms;
  }
}

export const spend = (key: string, kind: SpendEvent["kind"], amount: bigint, placed: number, occurred = placed, over: Partial<SpendEvent> = {}): SpendEvent => ({
  key,
  kind,
  amount,
  orderPlacedAtMs: placed,
  occurredAtMs: occurred,
  lines: [],
  verifiedSavings: 0n,
  plusSavings: 0n,
  ...over,
});

/** Direct use case wiring (no HTTP) over the in-memory store. */
export function createRuntime() {
  const clock = new FakeClock();
  let n = 0;
  const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}` };
  const store = new InMemoryBudgetStore();
  const consent = new FakeBudgetConsent();
  const cipher = new DevAesGcmFieldCipher();
  const spendSource = new FakeOrderSpendSource();
  const bag = new FakeBagTotal();
  const wishlists = new FakeWishlistPlanSource();
  const flags = new FakeBudgetFlags();
  const d: BudgetDeps = { store, clock, ids, consent, codec: new BudgetCodec(cipher), flags, spendSource, bag };
  return {
    clock,
    store,
    consent,
    cipher,
    spendSource,
    bag,
    wishlists,
    flags,
    d,
    set: new SetBudget(d),
    summary: new GetSummary(d),
    remove: new DeleteBudget(d),
    filter: new AffordabilityFilter(d),
    plan: new PlanMyPurchases(d, wishlists),
    unlock: new RequestCapUnlock(d),
    guard: new CheckoutCapGuard(d),
    record: new RecordSpend(d),
    reconcile: new ReconcileSpend(d),
    ingest: new IngestProviderCommitments(d),
    roll: new RollCycles(d, store),
    purge: new PurgeUserBudget(d),
    exporter: new ExportBudgetData(d),
  };
}
export type Runtime = ReturnType<typeof createRuntime>;

// ---- HTTP harness ----------------------------------------------------------------------------

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
  shopperOnSellerAud: "token-shopper-on-seller-aud-05",
};

const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });

export interface BudgetHarness {
  readonly app: INestApplication;
  readonly rt: Runtime;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createBudgetHarness(): Promise<BudgetHarness> {
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
  tokens.add(TOKENS.shopperOnSellerAud, { actor: shopper(U(1)), aud: "seller_api" });

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
      BudgetModule.forRoot(config, {
        store: rt.store,
        consent: rt.consent,
        cipher: rt.cipher,
        spendSource: rt.spendSource,
        bag: rt.bag,
        wishlists: rt.wishlists,
        flags: rt.flags,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  void T;
  return { app, rt, http: () => request(app.getHttpServer()), close: () => app.close() };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
