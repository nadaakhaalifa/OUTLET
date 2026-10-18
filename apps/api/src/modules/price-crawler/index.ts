/**
 * Public surface of the price-crawler module (A2.3). Other code imports only this file.
 * `CRAWLER_EXTERNAL_EVIDENCE` resolves to an object satisfying price-integrity's ExternalEvidencePort.
 */
export { PriceCrawlerModule, MissingCrawlerPortsError, type PriceCrawlerOptions } from "./price-crawler.module";
export * from "./adapters/tokens";
export {
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
export { KyselyCrawlStore, type CrawlDb } from "./adapters/kysely-store";
export {
  ChangeMatchingConfig,
  ConnectChannel,
  CrawlProduct,
  ExternalEvidenceReader,
  FindMatchCandidates,
  RefreshChannelToken,
  RegisterCrawlTarget,
  ScoreProductMatch,
  VerifyCrawlTarget,
  type CrawlResult,
} from "./application/crawler";
export type {
  AttributeCheckPort,
  ChannelRecord,
  CrawlEvent,
  CrawlFlagsPort,
  CrawlStore,
  DnsResolverPort,
  DomainVerifierPort,
  EmbeddingIndexPort,
  FingerprintSource,
  HttpFetchPort,
  MatchRecord,
  OfferParserPort,
  SnapshotRecord,
  TargetRecord,
  TokenVaultPort,
} from "./domain/ports";
export { ListCrawlIncidents, ListParityWarnings, PriceIntegrityParityAdapter, PARITY_FIX_WINDOW_MS, type TrustReader } from "./application/incidents";
export type { IncidentRow, ParityWarning, ParityWarningsPort } from "./domain/ports";
