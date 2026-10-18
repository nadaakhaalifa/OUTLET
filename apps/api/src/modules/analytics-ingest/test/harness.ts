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
  FakeAttestationCheck,
  FakeKeyer,
  InMemoryBatchOutbox,
  InMemoryConsentReader,
  InMemoryPlausibilityStore,
  RecordingCounters,
  StaticGate,
  StaticVocabulary,
} from "../adapters/in-memory";
import { AnalyticsIngestModule } from "../analytics-ingest.module";

export const T0 = 1_800_000_000_000;
export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const SHOPPER = U(1);
export const OTHER_SHOPPER = U(2);

export class FakeClock implements Clock {
  constructor(private ms = T0) {}
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
  readonly sid: string;
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
      iss: "test", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `jti-${bearer}`, sid: s.sid, amr: ["otp_sms"],
    };
    return { actor: s.actor, claims };
  }
}

const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });

export const TOKENS = {
  shopperS1: "token-ingest-shopper-s1-000001",
  shopperS2: "token-ingest-shopper-s2-000002",
  other: "token-ingest-other-000000000003",
  seller: "token-ingest-seller-0000000004",
  admin: "token-ingest-admin-00000000005",
};
export const ATTEST = { "X-App-Attest": "ok:device-1", "X-Client-Platform": "ios" } as const;

export interface IngestHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly gate: StaticGate;
  readonly consent: InMemoryConsentReader;
  readonly store: InMemoryPlausibilityStore;
  readonly outbox: InMemoryBatchOutbox;
  readonly counters: RecordingCounters;
  post(token: string | null, body: unknown, opts?: { headers?: Record<string, string>; key?: string }): ReturnType<ReturnType<typeof request>["post"]>;
  close(): Promise<void>;
}

let keySeq = 0;
export const idemKey = (): string => `0192f3a4-5b6c-7d8e-9f01-${String(0x2000000000 + (keySeq += 1)).padStart(12, "0")}`;

export async function createIngestHarness(opts: { vocabulary?: readonly string[] } = {}): Promise<IngestHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.shopperS1, { actor: shopper(SHOPPER), aud: "buyer_api", sid: "sid-1" });
  tokens.add(TOKENS.shopperS2, { actor: shopper(SHOPPER), aud: "buyer_api", sid: "sid-2" });
  tokens.add(TOKENS.other, { actor: shopper(OTHER_SHOPPER), aud: "buyer_api", sid: "sid-3" });
  tokens.add(TOKENS.seller, { actor: shopper(U(50)), aud: "seller_api", sid: "sid-4" });
  tokens.add(TOKENS.admin, { actor: shopper(U(51)), aud: "admin_api", sid: "sid-5" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const gate = new StaticGate(true);
  const consent = new InMemoryConsentReader();
  consent.set(SHOPPER, true);
  consent.set(OTHER_SHOPPER, true);
  const store = new InMemoryPlausibilityStore(() => clock.nowMs());
  const outbox = new InMemoryBatchOutbox();
  const counters = new RecordingCounters();
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      AnalyticsIngestModule.forRoot(config, {
        gate,
        attestation: new FakeAttestationCheck(),
        consent,
        store,
        outbox,
        keyer: new FakeKeyer(),
        vocabulary: new StaticVocabulary(new Set(opts.vocabulary ?? ["dress", "linen", "white", "فستان"])),
        counters,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  const http = () => request(app.getHttpServer());
  return {
    app, clock, gate, consent, store, outbox, counters,
    post: (token, body, o = {}) => {
      let r = http().post("/v1/analytics/events");
      if (token !== null) r = r.set("Authorization", `Bearer ${token}`);
      r = r.set("Idempotency-Key", o.key ?? idemKey());
      for (const [k, v] of Object.entries(o.headers ?? ATTEST)) r = r.set(k, v);
      return r.send(body as object);
    },
    close: () => app.close(),
  };
}

export const iso = (ms: number): string => new Date(ms).toISOString();
export const PRODUCT = (n: number): string => `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`;
export const STORE = "00000000-0000-4000-a000-00000000000a";
export const EV = (n: number): string => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;

export const viewEvent = (n: number, atMs: number, source = "feed", product = PRODUCT(n)) => ({
  event_id: EV(n),
  name: "product_viewed" as const,
  occurred_at: iso(atMs),
  properties: { store_id: STORE, product_id: product, source },
});
export const batch = (sentAtMs: number, events: unknown[]) => ({ sent_at: iso(sentAtMs), events });
