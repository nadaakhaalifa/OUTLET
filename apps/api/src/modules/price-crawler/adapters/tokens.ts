export const CRAWL_STORE = Symbol("crawler.CrawlStore");
export const CRAWL_FLAGS = Symbol("crawler.CrawlFlagsPort");
export const CRAWL_FETCH = Symbol("crawler.HttpFetchPort");
export const CRAWL_DNS = Symbol("crawler.DnsResolverPort");
export const CRAWL_PARSER = Symbol("crawler.OfferParserPort");
export const CRAWL_VERIFIER = Symbol("crawler.DomainVerifierPort");
export const CRAWL_VAULT = Symbol("crawler.TokenVaultPort");
export const CRAWL_EMBEDDINGS = Symbol("crawler.EmbeddingIndexPort");
export const CRAWL_ATTRIBUTES = Symbol("crawler.AttributeCheckPort");
export const CRAWL_FINGERPRINTS = Symbol("crawler.FingerprintSource");
export const CRAWL_METRICS = Symbol("crawler.CrawlMetrics");

export const CRAWL_STORE_RESOLVER = Symbol("crawler.StoreResolver");
export const CRAWL_STORE_PRODUCT_RESOLVER = Symbol("crawler.StoreProductResolver");
export const CRAWL_CONFIG_RESOLVER = Symbol("crawler.ConfigResolver");

export const REGISTER_CRAWL_TARGET = Symbol("crawler.RegisterCrawlTarget");
export const VERIFY_CRAWL_TARGET = Symbol("crawler.VerifyCrawlTarget");
export const CONNECT_CHANNEL = Symbol("crawler.ConnectChannel");
export const REFRESH_CHANNEL_TOKEN = Symbol("crawler.RefreshChannelToken");
export const CRAWL_PRODUCT = Symbol("crawler.CrawlProduct");
export const SCORE_PRODUCT_MATCH = Symbol("crawler.ScoreProductMatch");
export const FIND_MATCH_CANDIDATES = Symbol("crawler.FindMatchCandidates");
export const CHANGE_MATCHING_CONFIG = Symbol("crawler.ChangeMatchingConfig");
export const CRAWLER_EXTERNAL_EVIDENCE = Symbol("crawler.ExternalEvidence");
export const CRAWL_READS = Symbol("crawler.Reads");

export const CRAWL_LIST_INCIDENTS = Symbol("crawler.ListCrawlIncidents");
export const CRAWL_LIST_PARITY = Symbol("crawler.ListParityWarnings");
export const CRAWL_PARITY = Symbol("crawler.ParityWarningsPort");
export const CRAWL_ADMIN_RESOLVER = Symbol("crawler.AdminConsoleResolver");
