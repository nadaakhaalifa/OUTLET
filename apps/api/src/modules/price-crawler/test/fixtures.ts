import { createIdGenerator, nodeCsprng, type Clock } from "../../../platform";
import {
  FakeAttributeCheck,
  FakeDns,
  FakeDomainVerifier,
  FakeEmbeddingIndex,
  FakeFingerprints,
  FakeHttpFetch,
  FakeTokenVault,
  InMemoryCrawlMetrics,
  InMemoryCrawlStore,
  JsonOfferParser,
  StaticCrawlFlags,
} from "../adapters/in-memory";
import type { CrawlerDeps } from "../application/crawler";
import { DomainPacer } from "../domain/matching";
import type { TargetRecord } from "../domain/ports";

export const START_MS = 1_800_000_000_000;
export const HOUR = 3_600_000;
export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
export const STORE_A = U(1000);
export const STORE_B = U(1001);

export class FakeClock implements Clock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface Fixture {
  readonly clock: FakeClock;
  readonly store: InMemoryCrawlStore;
  readonly flags: StaticCrawlFlags;
  readonly fetcher: FakeHttpFetch;
  readonly dns: FakeDns;
  readonly verifier: FakeDomainVerifier;
  readonly vault: FakeTokenVault;
  readonly embeddings: FakeEmbeddingIndex;
  readonly attributes: FakeAttributeCheck;
  readonly fingerprints: FakeFingerprints;
  readonly metrics: InMemoryCrawlMetrics;
  readonly deps: CrawlerDeps;
}

export function createFixture(): Fixture {
  const clock = new FakeClock();
  const store = new InMemoryCrawlStore();
  const flags = new StaticCrawlFlags(true);
  const fetcher = new FakeHttpFetch();
  const dns = new FakeDns();
  const verifier = new FakeDomainVerifier();
  const vault = new FakeTokenVault();
  const embeddings = new FakeEmbeddingIndex();
  const attributes = new FakeAttributeCheck();
  const fingerprints = new FakeFingerprints();
  const metrics = new InMemoryCrawlMetrics();
  const deps: CrawlerDeps = {
    store,
    flags,
    fetcher,
    dns,
    parser: new JsonOfferParser(),
    verifier,
    vault,
    embeddings,
    attributes,
    fingerprints,
    metrics,
    clock,
    ids: createIdGenerator(clock, nodeCsprng),
    pacer: new DomainPacer(),
  };
  return { clock, store, flags, fetcher, dns, verifier, vault, embeddings, attributes, fingerprints, metrics, deps };
}

export const verifiedTarget = (over: Partial<TargetRecord> = {}): TargetRecord => ({
  id: U(2000),
  storeId: STORE_A,
  domain: "shop.example-brand.com",
  kind: "seller",
  status: "verified",
  verificationMethod: "dns_txt",
  verificationTokenHash: "0".repeat(64),
  consentAtMs: START_MS,
  verifiedAtMs: START_MS,
  robotsTxt: null,
  robotsStatus: null,
  robotsFetchedAtMs: null,
  breakerFailures: 0,
  breakerOpenedAtMs: null,
  lastEtag: null,
  ...over,
});

export const offerBody = (price: bigint, available = true, dom = "domhash0001"): string =>
  JSON.stringify({ price: price.toString(), available, dom });
