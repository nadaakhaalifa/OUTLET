import { randomBytes } from "node:crypto";
import { Logger, Module, type DynamicModule, type Provider } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import type { Clock } from "../../platform/ports";
import { Problems } from "../../platform/problem";
import { CLOCK } from "../../platform/tokens";
import { AnalyticsIngestController } from "./adapters/analytics-ingest.controller";
import {
  FakeAttestationCheck,
  FakeKeyer,
  InMemoryBatchOutbox,
  InMemoryConsentReader,
  InMemoryPlausibilityStore,
  RecordingCounters,
  StaticGate,
  StaticVocabulary,
} from "./adapters/in-memory";
import type { PrimableShopperKeyer } from "./adapters/primed-keyer";
import { ANALYTICS_INGEST_USE_CASE } from "./adapters/tokens";
import { IngestAnalyticsBatch } from "./application/ingest-batch";
import type { AttestationCheck, BatchOutbox, ConsentReader, IngestCounters, IngestGate, PlausibilityStore } from "./domain/ports";
import type { ShopperKeyer } from "./domain/producers";
import type { TermVocabulary } from "./domain/terms";

export interface AnalyticsIngestOverrides {
  readonly gate?: IngestGate;
  readonly attestation?: AttestationCheck;
  readonly consent?: ConsentReader;
  readonly store?: PlausibilityStore;
  readonly outbox?: BatchOutbox;
  readonly keyer?: ShopperKeyer;
  readonly vocabulary?: TermVocabulary;
  readonly counters?: IngestCounters;
  /** HMAC key for dedupe keys (so the plausibility store never holds a raw user id). */
  readonly dedupeKey?: Uint8Array;
}

/** Fail closed: every port throws a 503 until the composition root supplies a real adapter. */
const unconfigured = (name: string) => () => {
  throw Problems.unavailable(`analytics_ingest_unconfigured_${name}`);
};
const blocked: IngestGate = { enabled: async () => false };

/**
 * Dashboard foundations track 5 (client ingest). `kill.analytics.ingest` is allowed-when-true and
 * defaults to blocked: with no gate supplied the route answers 503 `analytics_ingest_disabled` and
 * nothing is read or stored. The composition PR (Wave 3) supplies the real flag gate, the verifier,
 * the Redis store, the Kysely consent reader and outbox, the HMAC keyer and the term vocabulary.
 */
@Module({})
export class AnalyticsIngestModule {
  static forRoot(config: AppConfig, o: AnalyticsIngestOverrides = {}): DynamicModule {
    const dev = config.adapters === "in-memory-dev";
    return {
      module: AnalyticsIngestModule,
      controllers: [AnalyticsIngestController],
      providers: [
        ...primingProviders(o.keyer),
        {
          provide: ANALYTICS_INGEST_USE_CASE,
          inject: [CLOCK],
          useFactory: (clock: Clock) =>
            new IngestAnalyticsBatch({
              gate: o.gate ?? (dev ? new StaticGate(false) : blocked),
              attestation: o.attestation ?? (dev ? new FakeAttestationCheck() : { verify: async () => unconfigured("attestation")() }),
              consent: o.consent ?? (dev ? new InMemoryConsentReader() : { analyticsConsent: async () => unconfigured("consent")() }),
              store: o.store ?? (dev ? new InMemoryPlausibilityStore(() => clock.nowMs()) : failingStore()),
              outbox: o.outbox ?? (dev ? new InMemoryBatchOutbox() : { append: async () => unconfigured("outbox")() }),
              keyer: o.keyer ?? (dev ? new FakeKeyer() : { shopperKey: unconfigured("keyer"), termHash: unconfigured("keyer") }),
              vocabulary: o.vocabulary ?? new StaticVocabulary(new Set()),
              counters: o.counters ?? new RecordingCounters(),
              // Never a constant outside dev: a per-process random key (dedupe keys only; the store is the shared part and fails closed).
              dedupeKey: o.dedupeKey ?? (dev ? new Uint8Array(32).fill(7) : new Uint8Array(randomBytes(32))),
            }),
        },
      ],
    };
  }
}

function failingStore(): PlausibilityStore {
  const f = async (): Promise<never> => unconfigured("store")();
  return { setIfAbsent: f, addToWindow: f, release: f };
}

const isPrimable = (k: unknown): k is PrimableShopperKeyer => typeof (k as { prime?: unknown } | undefined)?.prime === "function";

/**
 * Primes an async-loaded keyer before the module accepts traffic. A failed prime does NOT stop boot: the keyer
 * stays unprimed and fails closed (503) on use, behind kill.analytics.ingest. Only the error class is logged.
 */
function primingProviders(keyer: ShopperKeyer | undefined): Provider[] {
  if (!isPrimable(keyer)) return [];
  return [
    {
      provide: "ANALYTICS_KEYER_PRIMING",
      useFactory: () => ({
        async onModuleInit(): Promise<void> {
          try {
            await keyer.prime();
          } catch (e) {
            new Logger("AnalyticsIngest").warn(`pseudonym keyer not primed (${e instanceof Error ? e.name : "error"}); ingest answers 503`);
          }
        },
      }),
    },
  ];
}
