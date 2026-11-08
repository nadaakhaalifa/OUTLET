export interface DnsPort {
  resolve(host: string): Promise<readonly string[]>;
}
export interface OAuthPort {
  authorizeUrl(type: "shopify" | "woocommerce", domain: string, state: string): string;
  /** tokenRef is a KMS reference, never the token itself. */
  exchange(type: "shopify" | "woocommerce", domain: string, code: string): Promise<{ readonly tokenRef: string; readonly scopes: readonly string[] }>;
  revoke(tokenRef: string): Promise<void>;
}
/** Returns the values observed at the seller's domain (TXT records, meta tag contents, verify-file body); the service compares hashes. */
export interface DomainVerifierPort {
  observe(domain: string, method: "dns_txt" | "meta_tag" | "file"): Promise<readonly string[]>;
}
export interface RobotsPort {
  allowed(domain: string, path: string, userAgent: string): Promise<boolean>;
}
export interface ExternalItem {
  readonly externalRef: string;
  readonly variantRef?: string;
  readonly url?: string;
  readonly title?: string;
  readonly gtin?: string;
  readonly imagePhash?: Uint8Array;
  readonly priceMinor: bigint;
  readonly compareAtMinor?: bigint | null;
  readonly currency: string;
  readonly inStock: boolean;
  readonly domHash?: Uint8Array;
}
export interface FetchRequest {
  readonly url: string;
  /** The address validated by assertSafeTarget; the adapter must connect to it (DNS-rebinding guard) and send Host. */
  readonly address: string;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly etag?: string;
  readonly lastModified?: string;
}
export interface FetchResponse {
  readonly status: number;
  readonly location?: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly items: readonly ExternalItem[];
}
export interface ChannelFetchPort {
  fetch(req: FetchRequest): Promise<FetchResponse>;
}
export interface MatchCandidate {
  readonly skuId: string;
  readonly confidenceBp: number;
}
export interface ExternalProductView {
  readonly id: string;
  readonly storeId: string;
  readonly title: string | null;
  readonly gtin: string | null;
  readonly imagePhash: Uint8Array | null;
}
/** One stage of the matching waterfall (GTIN, pHash, embeddings, LLM attributes, classifier). Implementations live outside this package. */
export interface MatchStage {
  readonly method: "gtin" | "phash" | "embedding" | "llm" | "classifier";
  readonly modelVersion: string;
  find(item: ExternalProductView): Promise<MatchCandidate | null>;
}
