import type { EvidenceGate, MatchMethod, ProductFingerprint, AttributeVerdict } from "./matching";

export type TargetStatus = "pending_verification" | "verified" | "unreachable" | "blocked" | "revoked";
export type VerificationMethod = "dns_txt" | "file";
export type ChannelKind = "shopify" | "woocommerce" | "odoo" | "google_sheets" | "crawler";
export type ChannelStatus = "active" | "revoked" | "error";
export type IncidentKind =
  | "ssrf_refused"
  | "dns_rebinding"
  | "robots_disallowed"
  | "blocked"
  | "parser_error"
  | "size_exceeded"
  | "redirect_refused"
  | "kill_switch";

export interface TargetRecord {
  readonly id: string;
  readonly storeId: string;
  readonly domain: string;
  readonly kind: "seller" | "brand_rrp";
  readonly status: TargetStatus;
  readonly verificationMethod: VerificationMethod;
  /** sha256 hex of the verification token. The plaintext is shown once and never stored. */
  readonly verificationTokenHash: string;
  readonly consentAtMs: number;
  readonly verifiedAtMs: number | null;
  readonly robotsTxt: string | null;
  readonly robotsStatus: number | null;
  readonly robotsFetchedAtMs: number | null;
  readonly breakerFailures: number;
  readonly breakerOpenedAtMs: number | null;
  readonly lastEtag: string | null;
}

export interface ChannelRecord {
  readonly id: string;
  readonly storeId: string;
  readonly kind: ChannelKind;
  readonly status: ChannelStatus;
  /** Opaque reference into the secret manager. The token itself never enters this process or the DB. */
  readonly tokenRef: string;
  readonly kmsKeyRef: string;
  readonly targetId: string | null;
  readonly createdAtMs: number;
  readonly revokedAtMs: number | null;
}

export interface SnapshotRecord {
  readonly id: string;
  readonly targetId: string;
  readonly storeId: string;
  readonly skuRef: string;
  /** VAT-inclusive integer piastres. */
  readonly priceAmount: bigint;
  readonly available: boolean;
  readonly domHash: string;
  readonly etag: string | null;
  readonly fetchedAtMs: number;
}

export interface MatchRecord {
  readonly id: string;
  readonly skuId: string;
  readonly storeId: string;
  readonly targetId: string;
  readonly externalRef: string;
  readonly method: Exclude<MatchMethod, "none">;
  readonly rawBp: number;
  readonly confBp: number;
  readonly capReason: string | null;
  readonly modelVersion: string;
  readonly gate: EvidenceGate;
  readonly scoredAtMs: number;
}

export interface MatchingConfigRecord {
  readonly tauBp: number;
  readonly shadowOnly: boolean;
  readonly version: number;
}

export interface ConfigChange {
  readonly id: string;
  readonly oldTauBp: number;
  readonly newTauBp: number;
  readonly oldShadow: boolean;
  readonly newShadow: boolean;
  readonly proposedBy: string;
  readonly approvedBy: string;
  readonly reason: string;
}

export interface IncidentRecord {
  readonly id: string;
  readonly targetId: string | null;
  readonly storeId: string | null;
  readonly kind: IncidentKind;
  readonly host: string;
  /** sha256 hex of the URL. URLs themselves are never stored. */
  readonly urlHash: string;
  readonly detail: string | null;
}

/** Outbox events. Payloads carry ids, enums and integers only. */
export type CrawlEvent =
  | { readonly type: "crawl_target.verified"; readonly targetId: string; readonly storeId: string }
  | { readonly type: "channel_snapshot.ingested"; readonly targetId: string; readonly storeId: string; readonly snapshotId: string }
  | { readonly type: "product_match.scored"; readonly matchId: string; readonly skuId: string; readonly storeId: string; readonly gate: EvidenceGate }
  | { readonly type: "channel.token_revoked"; readonly channelId: string; readonly storeId: string }
  | { readonly type: "matching_config.changed"; readonly changeId: string; readonly shadowOnly: boolean }
  | { readonly type: "crawl.incident"; readonly incidentId: string; readonly kind: IncidentKind };

export interface CrawlStore {
  insertTarget(t: TargetRecord): Promise<{ readonly kind: "created" | "exists"; readonly target: TargetRecord }>;
  getTarget(id: string): Promise<TargetRecord | null>;
  listTargets(storeId: string): Promise<readonly TargetRecord[]>;
  /** Verified targets, oldest robots fetch first. */
  listVerifiedTargets(limit: number): Promise<readonly TargetRecord[]>;
  /** Replaces mutable fields of one target; `events` are appended in the same transaction. */
  updateTarget(t: TargetRecord, events: readonly CrawlEvent[]): Promise<void>;
  /** Verified domains of a store (the SSRF allow-list). */
  verifiedDomains(storeId: string): Promise<readonly string[]>;

  insertChannel(c: ChannelRecord): Promise<void>;
  getChannel(id: string): Promise<ChannelRecord | null>;
  listChannels(storeId: string): Promise<readonly ChannelRecord[]>;
  updateChannel(c: ChannelRecord, events: readonly CrawlEvent[]): Promise<void>;

  latestSnapshot(targetId: string, skuRef: string): Promise<SnapshotRecord | null>;
  snapshotsSince(targetId: string, skuRef: string, sinceMs: number): Promise<readonly SnapshotRecord[]>;
  insertSnapshot(s: SnapshotRecord, events: readonly CrawlEvent[]): Promise<void>;

  upsertMatch(m: MatchRecord, events: readonly CrawlEvent[]): Promise<void>;
  matchesForSkus(skuIds: readonly string[], gate: EvidenceGate): Promise<readonly MatchRecord[]>;
  matchesForStore(storeId: string, limit: number): Promise<readonly MatchRecord[]>;

  getConfig(): Promise<MatchingConfigRecord>;
  applyConfigChange(c: ConfigChange, events: readonly CrawlEvent[]): Promise<MatchingConfigRecord>;
  labelStats(): Promise<{ readonly pairs: number; readonly kappaMilli: number }>;

  addIncident(i: IncidentRecord, events: readonly CrawlEvent[]): Promise<void>;
}

// ---- ports owned by other systems (always faked here, no real HTTP) ----

export interface CrawlFlagsPort {
  /** `kill.crawlers`: true means crawling may run. Fails closed. */
  crawlingEnabled(): Promise<boolean>;
}

export interface FetchRequest {
  readonly url: string;
  readonly host: string;
  /** The address the connection must be made to (DNS answer pinned by the caller). */
  readonly pinnedAddress: string;
  readonly ifNoneMatch: string | null;
  readonly maxBytes: number;
}
export interface FetchResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** The remote address actually connected to, for the rebinding re-check. */
  readonly connectedAddress: string;
  readonly truncated: boolean;
}
/** Egress goes through the allow-listed proxy. Throws on network failure (the caller counts it). */
export interface HttpFetchPort {
  get(req: FetchRequest): Promise<FetchResponse>;
}

/** Resolves a host name; called again after the fetch so a rebinding answer is caught. */
export interface DnsResolverPort {
  resolve(host: string): Promise<readonly string[]>;
}

export interface ParsedOffer {
  /** VAT-inclusive integer piastres. */
  readonly priceAmount: bigint;
  readonly available: boolean;
  readonly domHash: string;
}
export interface OfferParserPort {
  parse(body: string, url: string): ParsedOffer | null;
}

export interface DomainVerifierPort {
  /** The token found at the DNS TXT record or the well-known file, or null. */
  findToken(domain: string, method: VerificationMethod): Promise<string | null>;
}

export interface TokenVaultPort {
  /** True when the reference exists in the secret manager (the secret is never read here). */
  exists(tokenRef: string, kmsKeyRef: string): Promise<boolean>;
  /** Rotates an OAuth token. `revoked` means the seller withdrew consent. */
  refresh(tokenRef: string, kmsKeyRef: string): Promise<{ readonly kind: "refreshed"; readonly tokenRef: string } | { readonly kind: "revoked" }>;
}

export interface EmbeddingCandidate {
  readonly externalRef: string;
  readonly targetId: string;
  readonly similarity: number;
}
export interface EmbeddingIndexPort {
  nearest(embedding: readonly number[], k: number): Promise<readonly EmbeddingCandidate[]>;
}

/** The LLM attribute check, behind the llm-gateway (no P2/P3 data, schema-constrained output). */
export interface AttributeCheckPort {
  /** null = gateway unavailable or output invalid (the score then fails closed). */
  check(a: ProductFingerprintFacts, b: ProductFingerprintFacts): Promise<AttributeVerdict | null>;
}
export interface ProductFingerprintFacts {
  readonly title: string;
  readonly brand: string | null;
  readonly colour: string | null;
  readonly material: string | null;
  readonly sizes: readonly string[];
}

export interface FingerprintSource {
  haulSku(skuId: string): Promise<{ readonly storeId: string; readonly fp: ProductFingerprint; readonly facts: ProductFingerprintFacts } | null>;
  externalProduct(targetId: string, externalRef: string): Promise<{ readonly fp: ProductFingerprint; readonly facts: ProductFingerprintFacts } | null>;
}

export interface CrawlMetrics {
  increment(name: string, labels?: Readonly<Record<string, string>>): void;
}
