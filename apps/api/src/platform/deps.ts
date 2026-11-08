import type { DefectService, ListingService, PublicCatalogService } from "@outlet/catalog";
import type { RoleSqlClient } from "@outlet/db";
import type { KillSwitchName } from "@outlet/flags";
import type { BeginInput, BeginResult, StoredResponse } from "@outlet/idempotency";
import type { Logger } from "@outlet/logger";
import type { AccessTokenVerifier, StoreMembershipPort } from "./auth-ports.js";
import type { DealsPort } from "../modules/catalog-public/deals-reader.js";
import type { DiscoveryPort } from "../modules/catalog-public/discovery-reader.js";
import type { Clock } from "./http.js";
import type { RateLimiterPort } from "./rate-limit/port.js";

export const API_DEPS = Symbol("API_DEPS");

export interface IdempotencyPort {
  begin(input: BeginInput): Promise<BeginResult>;
  complete(input: Omit<BeginInput, "requestHash">, response: StoredResponse): Promise<void>;
  abandon(input: Omit<BeginInput, "requestHash">): Promise<void>;
}

export interface KillSwitchPort {
  isKilled(name: KillSwitchName, ctx: { marketId: string; userId?: string; storeId?: string }): Promise<boolean>;
}

export interface HttpConfig {
  /** Default 1 MiB. */
  readonly bodyLimitBytes: number;
  /** Server and handler timeout, default 10 s. */
  readonly requestTimeoutMs: number;
  /** Fastify trustProxy: the edge (Cloudflare / load balancer) addresses. false = use the socket address. */
  readonly trustProxy: boolean | string | readonly string[];
  /** Read the ASN from `X-Client-ASN` (set by the edge only). */
  readonly trustAsnHeader: boolean;
  /** HMAC key for rate-limit keys, so raw ids and IPs never reach Redis. */
  readonly rateLimitKeySecret: string;
}

export const DEFAULT_HTTP_CONFIG: HttpConfig = Object.freeze({
  bodyLimitBytes: 1024 * 1024,
  requestTimeoutMs: 10_000,
  trustProxy: false,
  trustAsnHeader: false,
  rateLimitKeySecret: "",
});

export interface CatalogServices {
  readonly publicCatalog: Pick<PublicCatalogService, "getStoreBySlug" | "getListing">;
  /** Store directory, category tree and the store shelf with quick-view fields (published read model only). */
  readonly discovery: DiscoveryPort;
  /** Verified-discount bands (Price Watch evidence; empty until history exists). */
  readonly deals: DealsPort;
  readonly defects: Pick<DefectService, "lookupPassport">;
  readonly listings: Pick<ListingService, "createDraft">;
}

/** Everything the HTTP layer needs, injected once (composition root: cli.ts in production, test/harness.ts in tests). */
export interface ApiDeps {
  readonly http: HttpConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  /** outlet_app pool (catalog.read); every transaction binds its own context (ADR-0011). */
  readonly appClient: RoleSqlClient<"outlet_app">;
  readonly tokens: AccessTokenVerifier;
  readonly memberships: StoreMembershipPort;
  readonly rateLimiter: RateLimiterPort;
  readonly idempotency: IdempotencyPort;
  readonly killSwitches: KillSwitchPort;
  /** Catalog services for one market (DB market id); built once per market by the composition root. */
  readonly catalog: (marketId: string) => CatalogServices;
  /** Set while the process drains (SIGTERM): readiness answers 503 so the balancer stops sending traffic. */
  readonly lifecycle: { draining: boolean };
}
