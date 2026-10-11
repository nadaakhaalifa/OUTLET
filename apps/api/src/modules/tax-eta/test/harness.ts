import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, AdminRole, BrandRole } from "@outlet/policy";
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
import {
  FakeEtaPort,
  InMemorySignedDocumentStore,
  InMemorySigningDelegations,
  InMemoryTaxConfigRepository,
  InMemoryTaxDocumentRepository,
  InMemoryTaxEtaEventPublisher,
} from "../adapters/in-memory";
import * as T from "../adapters/tokens";
import type { IssueDocument, PollSubmissionStatuses, ProcessSubmissionQueue, QuoteOrderTax, RunDailyReconciliation } from "../application/tax";
import { TaxEtaModule } from "../tax-eta.module";

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

interface Subject {
  readonly actor: Actor;
  readonly aud: AccessClaims["aud"];
}

class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, Subject>();
  add(token: string, subject: Subject): void {
    this.subjects.set(token, subject);
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

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
export const STORE_A = U(9001);
export const STORE_B = U(9002);

const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });
const seller = (id: string, storeId: string, role: BrandRole, scopes: string[] = ["seller:read", "seller:write"]): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "brand", storeId, role }],
  tokenScopes: scopes as Actor["tokenScopes"],
});
const admin = (id: string, role: AdminRole, assurance: Actor["assurance"] = "passkey"): Actor => ({
  id,
  status: "active",
  assurance,
  grants: [{ kind: "admin", role }],
  tokenScopes: ["admin:access"],
});

export const TOKENS = {
  shopper: "token-shopper-one-00000001",
  ownerA: "token-seller-owner-a-0000004",
  financeA: "token-seller-finance-a-0005",
  catalogA: "token-seller-catalog-a-0007",
  ownerB: "token-seller-owner-b-0000009",
  adminFinance: "token-admin-finance-0000021",
  adminOps: "token-admin-ops-000000000022",
  adminSupport: "token-admin-support-0000023",
  adminNoPasskey: "token-admin-finance-nopk-24",
  buyerAudAdmin: "token-admin-on-buyer-aud-0025",
  sellerAudAdmin: "token-admin-on-seller-aud-26",
};

export interface TaxHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly config: InMemoryTaxConfigRepository;
  readonly documents: InMemoryTaxDocumentRepository;
  readonly eta: FakeEtaPort;
  readonly signed: InMemorySignedDocumentStore;
  readonly delegations: InMemorySigningDelegations;
  readonly events: InMemoryTaxEtaEventPublisher;
  readonly audit: InMemoryAuditSink;
  readonly issue: IssueDocument;
  readonly quote: QuoteOrderTax;
  readonly queue: ProcessSubmissionQueue;
  readonly poll: PollSubmissionStatuses;
  readonly reconcile: RunDailyReconciliation;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createTaxHarness(): Promise<TaxHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.shopper, { actor: shopper(U(1)), aud: "buyer_api" });
  tokens.add(TOKENS.ownerA, { actor: seller(U(11), STORE_A, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.financeA, { actor: seller(U(12), STORE_A, "finance"), aud: "seller_api" });
  tokens.add(TOKENS.catalogA, { actor: seller(U(13), STORE_A, "catalog"), aud: "seller_api" });
  tokens.add(TOKENS.ownerB, { actor: seller(U(14), STORE_B, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.adminFinance, { actor: admin(U(21), "finance"), aud: "admin_api" });
  tokens.add(TOKENS.adminOps, { actor: admin(U(22), "ops"), aud: "admin_api" });
  tokens.add(TOKENS.adminSupport, { actor: admin(U(23), "support"), aud: "admin_api" });
  tokens.add(TOKENS.adminNoPasskey, { actor: admin(U(24), "finance", "basic"), aud: "admin_api" });
  tokens.add(TOKENS.buyerAudAdmin, { actor: admin(U(25), "finance"), aud: "buyer_api" });
  tokens.add(TOKENS.sellerAudAdmin, { actor: admin(U(26), "finance"), aud: "seller_api" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const cfg = new InMemoryTaxConfigRepository();
  const documents = new InMemoryTaxDocumentRepository();
  const eta = new FakeEtaPort();
  const signed = new InMemorySignedDocumentStore();
  const delegations = new InMemorySigningDelegations();
  const events = new InMemoryTaxEtaEventPublisher();
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      TaxEtaModule.forRoot(config, { config: cfg, documents, eta, signed, delegations, events }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  const get = <X>(token: symbol): X => app.get<X>(token, { strict: false });
  return {
    app,
    clock,
    config: cfg,
    documents,
    eta,
    signed,
    delegations,
    events,
    audit: get<InMemoryAuditSink>(AUDIT_SINK),
    issue: get(T.ISSUE_DOCUMENT),
    quote: get(T.QUOTE_ORDER_TAX),
    queue: get(T.PROCESS_SUBMISSION_QUEUE),
    poll: get(T.POLL_SUBMISSION_STATUSES),
    reconcile: get(T.RUN_DAILY_RECONCILIATION),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
