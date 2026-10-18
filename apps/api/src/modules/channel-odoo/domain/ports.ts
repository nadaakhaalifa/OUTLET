/**
 * Odoo seller-channel adapter ports (master prompt 9.2 and 19, Phase 3 item 11).
 * Every port here is owned by this module and implemented elsewhere (composition) or faked in tests.
 * No port ever returns the API key or the login: the secret is injected by the egress adapter.
 */

export type OdooChannelStatus = "active" | "revoked" | "error";

export interface OdooConfig {
  readonly channelId: string;
  readonly storeId: string;
  /** The seller-verified crawl target whose domain is the only host this channel may call. */
  readonly targetId: string;
  readonly database: string;
  readonly uid: number;
  readonly pricelistId: number | null;
  readonly stockLocationId: number | null;
  readonly pollIntervalSeconds: number;
  readonly breakerFailures: number;
  readonly breakerOpenedAtMs: number | null;
  readonly lastPolledAtMs: number | null;
  readonly lastErrorCode: OdooErrorCode | null;
  readonly createdAtMs: number;
}

export interface ProductLink {
  readonly channelId: string;
  readonly odooProductId: number;
  readonly storeId: string;
  readonly skuId: string;
  readonly lastPriceAmount: bigint | null;
  readonly lastStockSourceVersion: number | null;
  readonly lastStockQty: number | null;
  readonly lastSyncedAtMs: number | null;
}

export type OdooErrorCode =
  | "kill_switch"
  | "ssrf_refused"
  | "dns_rebinding"
  | "redirect_refused"
  | "http_error"
  | "network_error"
  | "size_exceeded"
  | "rpc_error"
  | "bad_response"
  | "auth_failed"
  | "currency_unsupported"
  | "breaker_open"
  | "rate_limited";

export interface OdooStore {
  insertConfig(c: OdooConfig): Promise<{ readonly kind: "created" | "exists"; readonly config: OdooConfig }>;
  getConfig(channelId: string): Promise<OdooConfig | null>;
  listConfigs(storeId: string): Promise<readonly OdooConfig[]>;
  /** Active channels whose next poll is due, oldest poll first. */
  listDue(nowMs: number, limit: number): Promise<readonly OdooConfig[]>;
  updateConfig(c: OdooConfig): Promise<void>;
  links(channelId: string): Promise<readonly ProductLink[]>;
  upsertLink(l: ProductLink): Promise<void>;
}

/** Wraps channel_connections (owned by price-crawler). Composition binds it to that module's store. */
export interface ChannelDirectoryPort {
  createChannel(i: {
    readonly id: string;
    readonly storeId: string;
    readonly tokenRef: string;
    readonly kmsKeyRef: string;
    readonly nowMs: number;
  }): Promise<void>;
  channel(channelId: string): Promise<{ readonly id: string; readonly storeId: string; readonly kind: string; readonly status: OdooChannelStatus; readonly tokenRef: string; readonly kmsKeyRef: string } | null>;
  revokeChannel(channelId: string, nowMs: number): Promise<void>;
  /** The domain of a verified crawl target of this store, else null (also null for another store's target). */
  verifiedTarget(storeId: string, targetId: string): Promise<{ readonly domain: string } | null>;
  verifiedDomains(storeId: string): Promise<readonly string[]>;
}

export interface SecretExistsPort {
  /** True when the reference exists in the secret manager; the secret is never read here. */
  exists(tokenRef: string, kmsKeyRef: string): Promise<boolean>;
}

export interface OdooFlagsPort {
  /** Backed by `kill.odoo_channel` (allowed-when-true, default blocked, ADR-0028). Fails closed. */
  enabled(): Promise<boolean>;
}

/** Placeholders the egress adapter replaces with the secret's fields after reading the vault. */
export const SECRET_LOGIN = "__ODOO_LOGIN__";
export const SECRET_API_KEY = "__ODOO_API_KEY__";

export interface OdooHttpRequest {
  readonly url: string;
  readonly host: string;
  /** The address the connection must be made to (DNS answer pinned by the caller). */
  readonly pinnedAddress: string;
  /** JSON-RPC envelope; may contain SECRET_LOGIN / SECRET_API_KEY placeholders only. */
  readonly jsonBody: string;
  readonly tokenRef: string;
  readonly kmsKeyRef: string;
  readonly maxBytes: number;
}
export interface OdooHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly connectedAddress: string;
  readonly truncated: boolean;
}
/** Egress through the allow-listed proxy. Throws on network failure (the caller counts it). */
export interface OdooEgressPort {
  postJson(req: OdooHttpRequest): Promise<OdooHttpResponse>;
}

export interface OdooDnsPort {
  resolve(host: string): Promise<readonly string[]>;
}

/** Maps the seller's Odoo `default_code` to a Z-OUTLET SKU of that store. Other stores' SKUs never resolve. */
export interface SellerSkuResolverPort {
  resolve(storeId: string, sellerSkus: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export interface StockSinkPort {
  /** Idempotent, versioned absolute stock set (inventory SyncSellerStock). */
  set(i: {
    readonly skuId: string;
    readonly storeId: string;
    readonly quantity: number;
    readonly sourceVersion: number;
    readonly idempotencyKey: string;
    readonly actorId: string;
  }): Promise<"applied" | "replayed" | "stale" | "rejected">;
}

export interface PriceSinkPort {
  /** Appends to the immutable price ledger with source = odoo. */
  record(i: {
    readonly skuId: string;
    readonly storeId: string;
    readonly priceAmount: bigint;
    readonly validFromMs: number;
    readonly idempotencyKey: string;
  }): Promise<"recorded" | "replayed" | "rejected">;
}

export interface OdooMetrics {
  increment(name: string, labels?: Readonly<Record<string, string>>): void;
}

export interface OdooClock {
  nowMs(): number;
}
export interface OdooSleeper {
  sleep(ms: number): Promise<void>;
}

// ---- production egress (the real OdooEgressPort is built from these two ports) -------------------

/** Secret fields of one Odoo connection, read from the vault only at call time. Never logged. */
export interface OdooSecretFields {
  readonly login: string;
  readonly apiKey: string;
}
export interface OdooSecretReaderPort {
  /** Throws (never returns partial data) when the reference cannot be read. */
  read(tokenRef: string, kmsKeyRef: string): Promise<OdooSecretFields>;
}

export interface EgressProxyPostRequest {
  readonly url: string;
  readonly host: string;
  /** The proxy must connect to this address (the caller's validated DNS answer). */
  readonly pinnedAddress: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  /** Always false: a redirect is returned as a 3xx and refused by the caller. */
  readonly followRedirects: false;
}
export interface EgressProxyPostResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly connectedAddress: string;
  readonly truncated: boolean;
}
/** The allow-listed egress proxy (the same infrastructure as the crawler fetcher), POST variant. */
export interface EgressProxyPort {
  post(req: EgressProxyPostRequest): Promise<EgressProxyPostResponse>;
}
