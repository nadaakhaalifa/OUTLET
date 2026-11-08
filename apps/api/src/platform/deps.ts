import type { DefectService, ListingService, PublicCatalogService, VariantService } from "@outlet/catalog";
import type { RoleSqlClient } from "@outlet/db";
import type { KillSwitchName } from "@outlet/flags";
import type { BeginInput, BeginResult, StoredResponse } from "@outlet/idempotency";
import type { Logger } from "@outlet/logger";
import type { MediaService } from "@outlet/media";
import type { AccessTokenVerifier, StoreMembershipPort } from "./auth-ports.js";
import type { DealsPort } from "../modules/catalog-public/deals-reader.js";
import type { AttributeSetPort } from "../modules/seller-catalog/attribute-set-reader.js";
import type { DiscoveryPort } from "../modules/catalog-public/discovery-reader.js";
import type { AdminServices } from "../modules/admin/services.js";
import type { AddressesServices } from "../modules/addresses/services.js";
import type { AuthServices } from "../modules/auth/ports.js";
import type { CartServices } from "../modules/cart/ports.js";
import type { CheckoutServices, WebhookIpPolicy } from "../modules/checkout/ports.js";
import type { ReturnsServices } from "../modules/returns/services.js";
import type { SellerOnboardingServices } from "../modules/seller-onboarding/services.js";
import type { TrackingServices } from "../modules/tracking/services.js";
import type { SellerInventoryServices } from "../modules/seller-inventory/services.js";
import type { SellerOrdersServices } from "../modules/seller-orders/services.js";
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

export type { SellerInventoryServices, SellerOrdersServices };

export interface CatalogServices {
  readonly publicCatalog: Pick<PublicCatalogService, "getStoreBySlug" | "getListing">;
  /** Store directory, category tree and the store shelf with quick-view fields (published read model only). */
  readonly discovery: DiscoveryPort;
  /** Verified-discount bands (Price Watch evidence; empty until history exists). */
  readonly deals: DealsPort;
  readonly defects: Pick<DefectService, "lookupPassport" | "putDefectCard">;
  readonly listings: Pick<ListingService, "createDraft" | "get" | "listOwn" | "readiness" | "updateDetails" | "setConditionAndMedia" | "activate">;
  readonly variants: Pick<VariantService, "list" | "create" | "update">;
  /** Photo ingest (sniff, AV scan, renditions). Production wiring is fail-closed until storage and the scanner are configured. */
  readonly media: Pick<MediaService, "ingest">;
  readonly attributeSets: AttributeSetPort;
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
  /** Auth services for one market (outlet_auth pool, ADR-0011). */
  readonly auth: (marketId: string) => AuthServices;
  readonly cart: (marketId: string) => CartServices;
  readonly checkout: (marketId: string) => CheckoutServices;
  /** Seller Center orders (accept, reject, pack, ship) for one market. Courier, buyer delivery data and payment kind are ports: production fails closed. */
  readonly sellerOrders: (marketId: string) => SellerOrdersServices;
  /** Seller Center stock levels and adjustments for one market. */
  readonly sellerInventory: (marketId: string) => SellerInventoryServices;
  /** The shopper's address book (encrypted P3 fields) and the geo picker for one market. */
  readonly addresses: (marketId: string) => AddressesServices;
  /** Returns, disputes, seller inspection and order cancellation for one market. */
  readonly returns: (marketId: string) => ReturnsServices;
  /** Shipment tracking reads and the courier webhook processor (worker job shipping.tracking) for one market. */
  readonly tracking: (marketId: string) => TrackingServices;
  /** Seller application (KYC), documents, IBAN and store team for one market. */
  readonly sellerOnboarding: (marketId: string) => SellerOnboardingServices;
  /** Admin Console services (staff principal, approvals, KYC decisions, reconciliation) for one market. Production fails closed until the staff stores are wired. */
  readonly admin: (marketId: string) => AdminServices;
  /** PSP source-address allow-list (first gate of the webhook route, before the HMAC). Deny-all until configured. */
  readonly webhookIps: WebhookIpPolicy;
  /** Set while the process drains (SIGTERM): readiness answers 503 so the balancer stops sending traffic. */
  readonly lifecycle: { draining: boolean };
}
