import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
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
} from "./adapters/in-memory";
import { CrawlerController } from "./adapters/crawler.controller";
import { CrawlIncidentsController, CrawlStoreAccess } from "./adapters/incidents.controller";
import { ListCrawlIncidents, ListParityWarnings } from "./application/incidents";
import { CrawlAdminResolver, CrawlStoreResolver, MatchingConfigResolver } from "./adapters/resolvers";
import * as T from "./adapters/tokens";
import {
  ChangeMatchingConfig,
  ConnectChannel,
  CrawlProduct,
  ExternalEvidenceReader,
  FindMatchCandidates,
  RefreshChannelToken,
  RegisterCrawlTarget,
  ScoreProductMatch,
  VerifyCrawlTarget,
  type CrawlerDeps,
} from "./application/crawler";
import { DomainPacer } from "./domain/matching";
import type {
  AttributeCheckPort,
  CrawlFlagsPort,
  CrawlMetrics,
  CrawlStore,
  DnsResolverPort,
  DomainVerifierPort,
  EmbeddingIndexPort,
  FingerprintSource,
  HttpFetchPort,
  OfferParserPort,
  ParityWarningsPort,
  TokenVaultPort,
} from "./domain/ports";

export interface PriceCrawlerOptions {
  readonly store?: CrawlStore;
  /** Backed by `kill.crawlers`. Fails closed. */
  readonly flags?: CrawlFlagsPort;
  /** Egress through the allow-listed proxy (SSRF boundary, API7). */
  readonly fetcher?: HttpFetchPort;
  readonly dns?: DnsResolverPort;
  readonly parser?: OfferParserPort;
  readonly verifier?: DomainVerifierPort;
  /** KMS / secret manager: the module only ever holds opaque references. */
  readonly vault?: TokenVaultPort;
  readonly embeddings?: EmbeddingIndexPort;
  /** Wraps the llm-gateway (no P2/P3, schema-constrained). */
  readonly attributes?: AttributeCheckPort;
  readonly fingerprints?: FingerprintSource;
  readonly metrics?: CrawlMetrics;
  /** Open cross-channel findings from price-integrity (PriceIntegrityParityAdapter). Default: none. */
  readonly parity?: ParityWarningsPort;
  /** Labelled validation split used to justify tau before leaving shadow mode. Empty fails closed. */
  readonly validationPairs?: () => Promise<readonly { readonly confBp: number; readonly same: boolean }[]>;
}

export class MissingCrawlerPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`PriceCrawlerModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingCrawlerPortsError";
  }
}

@Module({})
export class PriceCrawlerModule {
  static forRoot(config: AppConfig, o: PriceCrawlerOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.flags === undefined) missing.push("flags (kill.crawlers)");
      if (o.fetcher === undefined) missing.push("fetcher (allow-listed egress proxy)");
      if (o.dns === undefined) missing.push("dns (resolver for the rebinding guard)");
      if (o.parser === undefined) missing.push("parser (seller site adapters)");
      if (o.verifier === undefined) missing.push("verifier (DNS TXT / well-known file)");
      if (o.vault === undefined) missing.push("vault (KMS token references)");
      if (o.embeddings === undefined) missing.push("embeddings (ANN index)");
      if (o.attributes === undefined) missing.push("attributes (llm-gateway attribute check)");
      if (o.fingerprints === undefined) missing.push("fingerprints (catalog + external product source)");
      if (missing.length > 0) throw new MissingCrawlerPortsError(missing);
    }
    const store = o.store ?? new InMemoryCrawlStore();
    const flags = o.flags ?? new StaticCrawlFlags(true);
    const fetcher = o.fetcher ?? new FakeHttpFetch();
    const dns = o.dns ?? new FakeDns();
    const parser = o.parser ?? new JsonOfferParser();
    const verifier = o.verifier ?? new FakeDomainVerifier();
    const vault = o.vault ?? new FakeTokenVault();
    const embeddings = o.embeddings ?? new FakeEmbeddingIndex();
    const attributes = o.attributes ?? new FakeAttributeCheck();
    const fingerprints = o.fingerprints ?? new FakeFingerprints();
    const metrics = o.metrics ?? new InMemoryCrawlMetrics();
    const pacer = new DomainPacer();
    const parity: ParityWarningsPort = o.parity ?? { openFor: async () => [] };

    const RUNTIME = Symbol("crawler.Runtime");
    const runtime = (clock: Clock, ids: IdGenerator) => {
      const d: CrawlerDeps = { store, flags, fetcher, dns, parser, verifier, vault, embeddings, attributes, fingerprints, metrics, clock, ids, pacer };
      const score = new ScoreProductMatch(d);
      return {
        register: new RegisterCrawlTarget(d),
        verify: new VerifyCrawlTarget(d),
        connect: new ConnectChannel(d),
        refresh: new RefreshChannelToken(d),
        crawl: new CrawlProduct(d),
        score,
        find: new FindMatchCandidates(d, score),
        change: new ChangeMatchingConfig(d, o.validationPairs ?? (async () => [])),
        evidence: new ExternalEvidenceReader(d),
      };
    };
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({ provide: token, inject: [RUNTIME], useFactory: (r: Runtime) => pick(r) });
    return {
      module: PriceCrawlerModule,
      controllers: [CrawlerController, CrawlIncidentsController],
      providers: [
        { provide: T.CRAWL_STORE, useValue: store },
        { provide: T.CRAWL_FLAGS, useValue: flags },
        { provide: T.CRAWL_FETCH, useValue: fetcher },
        { provide: T.CRAWL_DNS, useValue: dns },
        { provide: T.CRAWL_PARSER, useValue: parser },
        { provide: T.CRAWL_VERIFIER, useValue: verifier },
        { provide: T.CRAWL_VAULT, useValue: vault },
        { provide: T.CRAWL_EMBEDDINGS, useValue: embeddings },
        { provide: T.CRAWL_ATTRIBUTES, useValue: attributes },
        { provide: T.CRAWL_FINGERPRINTS, useValue: fingerprints },
        { provide: T.CRAWL_METRICS, useValue: metrics },
        { provide: T.CRAWL_STORE_RESOLVER, useValue: new CrawlStoreResolver("store_settings") },
        { provide: T.CRAWL_STORE_PRODUCT_RESOLVER, useValue: new CrawlStoreResolver("store_product") },
        { provide: T.CRAWL_CONFIG_RESOLVER, useValue: new MatchingConfigResolver() },
        CrawlStoreAccess,
        { provide: T.CRAWL_PARITY, useValue: parity },
        { provide: T.CRAWL_ADMIN_RESOLVER, useValue: new CrawlAdminResolver() },
        { provide: T.CRAWL_LIST_INCIDENTS, useValue: new ListCrawlIncidents(store) },
        { provide: T.CRAWL_LIST_PARITY, inject: [CLOCK], useFactory: (c: Clock) => new ListParityWarnings(parity, () => c.nowMs()) },
        { provide: RUNTIME, inject: [CLOCK, ID_GENERATOR], useFactory: (c: Clock, ids: IdGenerator) => runtime(c, ids) },
        from(T.REGISTER_CRAWL_TARGET, (r) => r.register),
        from(T.VERIFY_CRAWL_TARGET, (r) => r.verify),
        from(T.CONNECT_CHANNEL, (r) => r.connect),
        from(T.REFRESH_CHANNEL_TOKEN, (r) => r.refresh),
        from(T.CRAWL_PRODUCT, (r) => r.crawl),
        from(T.SCORE_PRODUCT_MATCH, (r) => r.score),
        from(T.FIND_MATCH_CANDIDATES, (r) => r.find),
        from(T.CHANGE_MATCHING_CONFIG, (r) => r.change),
        from(T.CRAWLER_EXTERNAL_EVIDENCE, (r) => r.evidence),
      ],
      exports: [T.CRAWLER_EXTERNAL_EVIDENCE, T.CRAWL_PRODUCT, T.SCORE_PRODUCT_MATCH, T.FIND_MATCH_CANDIDATES, T.CHANGE_MATCHING_CONFIG, T.REFRESH_CHANNEL_TOKEN],
    };
  }
}
