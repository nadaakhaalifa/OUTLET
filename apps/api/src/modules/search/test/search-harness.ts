import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import {
  AGE_GATE,
  AGE_GATE_STORE,
  AUTH_EVENTS,
  AuthModule,
  DEV_OTP_MAILBOX,
  type AgeGate,
  type DevOtpMailbox,
  type InMemoryAgeGateStore,
  type InMemoryAuthEventPublisher,
} from "../../auth";
import { AUDIT_SINK, PlatformModule, createIdGenerator, nodeCsprng, type InMemoryAuditSink } from "../../../platform";
import { FakeClock, type Harness } from "../../../test/harness";
import {
  FakeLlmGateway,
  FakeProductFacts,
  InMemorySavedSearchRepository,
  InMemorySearchEventPublisher,
  InMemorySearchIndex,
  InMemorySuggestionDirectory,
  StaticKillSwitch,
  StaticShopperScope,
} from "../adapters/in-memory";
import { TypesenseSearchPort, type TypesenseTransport } from "../adapters/typesense";
import { SearchModule } from "../search.module";
import type { ProductFacts, SearchPort } from "../domain/ports";
import { storeSummary } from "../../cart";

export interface SearchHarness extends Harness {
  readonly index: InMemorySearchIndex;
  readonly facts: FakeProductFacts;
  readonly saved: InMemorySavedSearchRepository;
  readonly scope: StaticShopperScope;
  readonly killSwitch: StaticKillSwitch;
  readonly llm: FakeLlmGateway;
  readonly searchEvents: InMemorySearchEventPublisher;
  readonly directory: InMemorySuggestionDirectory;
}

export interface SearchHarnessOptions {
  readonly primary?: SearchPort;
  readonly transport?: TypesenseTransport;
}

/** Own Nest testing module: platform + auth (for login) + search only. */
export async function createSearchHarness(opts: SearchHarnessOptions = {}): Promise<SearchHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const index = new InMemorySearchIndex();
  const facts = new FakeProductFacts();
  const saved = new InMemorySavedSearchRepository();
  const scope = new StaticShopperScope();
  const killSwitch = new StaticKillSwitch(false);
  const llm = new FakeLlmGateway();
  const searchEvents = new InMemorySearchEventPublisher();
  const directory = new InMemorySuggestionDirectory();
  const primary = opts.primary ?? (opts.transport === undefined ? undefined : new TypesenseSearchPort(opts.transport));
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      AuthModule.forRoot(config),
      SearchModule.forRoot(config, {
        ...(primary !== undefined ? { primary } : {}),
        fallback: index,
        indexWriter: index,
        facts,
        savedSearches: saved,
        killSwitch,
        scope,
        directory,
        llm,
        events: searchEvents,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  const ageGate = app.get<AgeGate>(AGE_GATE, { strict: false });
  const ageGateStore = app.get<InMemoryAgeGateStore>(AGE_GATE_STORE, { strict: false });
  const grantAgeGate = (attestKeyId: string): void =>
    ageGateStore.grantPassForTest(ageGate.passKeyFor(attestKeyId), clock.nowMs() + 365 * 86_400_000);
  grantAgeGate("key-device-1");
  return {
    app,
    clock,
    config,
    events: app.get<InMemoryAuthEventPublisher>(AUTH_EVENTS, { strict: false }),
    ageGateStore,
    grantAgeGate,
    mailbox: app.get<DevOtpMailbox>(DEV_OTP_MAILBOX, { strict: false }),
    audit: app.get<InMemoryAuditSink>(AUDIT_SINK, { strict: false }),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
    index,
    facts,
    saved,
    scope,
    killSwitch,
    llm,
    searchEvents,
    directory,
  };
}

let seq = 0;
export const uid = (prefix = 0): string => {
  seq += 1;
  return `0192f3a4-5b6c-7d8e-9f01-${String(prefix * 1_000_000 + seq).padStart(12, "0")}`;
};

export const EGP = (pounds: bigint) => ({ amount: pounds * 100n, currency: "EGP" as const });

export function factsFor(productId: string, over: Partial<ProductFacts> = {}): ProductFacts {
  return {
    productId,
    title: { ar: "فستان", en: "Dress" },
    store: storeSummary(uid(9)),
    unitPrice: EGP(1000n),
    badge: "none",
    referencePrice: null,
    discountPct: null,
    condition: "new_with_tags",
    sponsored: false,
    purchasable: true,
    ...over,
  };
}
