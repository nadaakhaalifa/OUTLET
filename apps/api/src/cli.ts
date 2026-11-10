import "reflect-metadata";
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { createAdminAccess } from "@outlet/admin-access";
import { AesGcmFieldCipher, OtpService, PgRateLimiter, SessionService, createAuthDeps, registerDevice } from "@outlet/auth-core";
import { CartService, pgInventoryAvailability } from "@outlet/cart";
import { CheckoutService, OrderCloseJob, PgStoreCredit, WebhookProcessor } from "@outlet/checkout";
import { PgAuditStore } from "@outlet/audit-log";
import { brandClient } from "@outlet/db";
import { InventoryService, ReservationService } from "@outlet/inventory";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { PayoutService, UnconfiguredPayoutDestinations, UnconfiguredPayoutRail } from "@outlet/payouts";
import { uuidv7 } from "@outlet/ids";
import { InMemoryTaxRateProvider } from "@outlet/tax";
import { DefectService, ListingService, PublicCatalogService, StoreService, VariantService } from "@outlet/catalog";
import type { CatalogDeps } from "@outlet/catalog";
import { FlagService, PostgresFlagStore } from "@outlet/flags";
import { IdempotencyStore } from "@outlet/idempotency";
import { createLogger } from "@outlet/logger";
import { listMarkets } from "@outlet/markets-config";
import { MediaError } from "@outlet/media";
import { initTelemetry } from "@outlet/observability";
import { PRICE_WATCH_KILL_SWITCH } from "@outlet/pricing-integrity";
import { SellerOnboardingService, UnconfiguredKycCheck } from "@outlet/seller-accounts";
import { AddressService } from "@outlet/shipping";
import { Redis } from "ioredis";
import pg from "pg";
import { createApp } from "./app.js";
import { PgAddressPort, postOrderServices } from "./post-order-production.js";
import type { PostOrderServices } from "./post-order-production.js";
import { parseEnv, parseWebhookIps, trustProxyList } from "./config.js";
import { PgChallengeStore, PgPasskeyStore, SessionReader, UnconfiguredDeviceAttestation, UnconfiguredFieldCipher, UnconfiguredOidc, UnconfiguredPasskeys, UnconfiguredSms, WebAuthnPasskeys, pgPhoneLabel } from "./modules/auth/index.js";
import type { AuthServices } from "./modules/auth/index.js";
import { noSuggestions } from "./modules/cart/index.js";
import type { CartServices } from "./modules/cart/index.js";
import {
  AesRawBodyCipher, FlagKillSwitches, HmacQuoteTokenPort, OrderGroupReader, PlainPrices, StandardTaxCategories, UnconfiguredBilling, UnconfiguredCommission,
  UnconfiguredPaymentProvider, productionOrderCancellation, productionPromotionsPort, UnconfiguredRefunds, UnconfiguredShipping, UnconfiguredSubMerchants, denyAllWebhookIps, productionCheckoutConfig, staticWebhookIps, unconfiguredCodConfirmation,
} from "./modules/checkout/index.js";
import type { CheckoutServices } from "./modules/checkout/index.js";
import { DealsReader } from "./modules/catalog-public/deals-reader.js";
import { DiscoveryReader } from "./modules/catalog-public/discovery-reader.js";
import { AttentionAdmin, DlqAdmin, FlagAdmin, PgApprovalReader, PgAuditReader, PgDashboardReader, PgElevationReader, PayoutsAdmin, PgKycAdmin, PgOpsLists, PgPiiAccessReader, PgReconciliationReader, StoreModeration, unconfiguredAdminServices } from "./modules/admin/index.js";
import type { AdminServices } from "./modules/admin/index.js";
import { AttributeSetReader } from "./modules/seller-catalog/index.js";
import { SellerInventoryService } from "./modules/seller-inventory/index.js";
import type { SellerInventoryServices } from "./modules/seller-inventory/index.js";
import { PgPaymentKind, SellerOrderService, UnconfiguredBuyerDelivery, UnconfiguredCourier } from "./modules/seller-orders/index.js";
import type { SellerOrdersServices } from "./modules/seller-orders/index.js";
import { SellerFinanceService } from "./modules/seller-finance/index.js";
import type { SellerFinanceServices } from "./modules/seller-finance/index.js";
import { SessionTokenVerifier, UnconfiguredStoreMemberships } from "./platform/auth-ports.js";
import type { MarketTokenService } from "./platform/auth-ports.js";
import { pgPoolOptions, pgSqlClient } from "./platform/db.js";
import type { PoolLike } from "./platform/db.js";
import type { ApiDeps, CatalogServices } from "./platform/deps.js";
import { systemClock } from "./platform/http.js";
import { Problems } from "./platform/problem.js";
import { MemoryRateLimiter } from "./platform/rate-limit/memory.js";
import { RedisRateLimiter } from "./platform/rate-limit/redis.js";

/** Production composition root (excluded from unit coverage; every part it wires is tested in test/). */
const env = parseEnv(process.env);
const logger = createLogger({ level: env.NODE_ENV === "production" ? "info" : "debug" });
const telemetry = initTelemetry({ serviceName: "outlex-api", env: env.NODE_ENV, exporter: env.OTEL_EXPORTER });

const pool = new pg.Pool(pgPoolOptions(env.DATABASE_URL_APP, "catalog.read", env.PG_POOL_MAX));
const appClient = pgSqlClient<"outlet_app">(pool);
// Auth-core paths (sessions, OTP) run on the outlet_auth pool tagged `auth`; outside production it falls back to the app pool.
const authPool = env.DATABASE_URL_AUTH === undefined ? undefined : new pg.Pool(pgPoolOptions(env.DATABASE_URL_AUTH, "auth", env.PG_POOL_MAX));
const authClient = authPool === undefined ? appClient : pgSqlClient(authPool as unknown as PoolLike);

/** WebCrypto parameters for ES256; Node's toCryptoKey rejects the JOSE name "ES256". */
const ES256_PARAMS = { name: "ECDSA", namedCurve: "P-256" } as const;
const privateKey = createPrivateKey(env.JWT_PRIVATE_KEY_PEM).toCryptoKey(ES256_PARAMS, false, ["sign"]);
const publicKey = createPublicKey(env.JWT_PUBLIC_KEY_PEM).toCryptoKey(ES256_PARAMS, true, ["verify"]);
const authPoolWorker = env.DATABASE_URL_WORKER === undefined ? undefined : new pg.Pool(pgPoolOptions(env.DATABASE_URL_WORKER, "worker", env.PG_POOL_MAX));
const prodOnly = (name: string, v: string | undefined): Buffer => {
  if (v !== undefined) return Buffer.from(v, "base64");
  if (env.NODE_ENV === "production") throw new Error(`${name} is required in production`);
  return randomBytes(32); // development: ephemeral, nothing survives a restart
};
const authDeps = createAuthDeps({
  hmacKey: prodOnly("AUTH_HMAC_KEY_B64", env.AUTH_HMAC_KEY_B64),
  cipherKey: prodOnly("AUTH_CIPHER_KEY_B64", env.AUTH_CIPHER_KEY_B64),
  // No KMS-backed cipher exists: without the explicit local opt-in, registrations (phone and DOB are stored encrypted) fail closed.
  cipher: process.env.OUTLET_LOCAL_CIPHER === "1" ? new AesGcmFieldCipher(prodOnly("AUTH_CIPHER_KEY_B64", env.AUTH_CIPHER_KEY_B64)) : new UnconfiguredFieldCipher(),
});
const quoteTokens = new HmacQuoteTokenPort(env.QUOTE_TOKEN_SECRET ?? (env.NODE_ENV === "production" ? "" : randomBytes(32).toString("hex")));
const rawKey = prodOnly("PAYMENT_RAW_KEY_B64", env.PAYMENT_RAW_KEY_B64);
const verifiers = new Map<string, MarketTokenService>();
const catalogs = new Map<string, CatalogServices>();
const auths = new Map<string, AuthServices>();
const carts = new Map<string, CartServices>();
const checkouts = new Map<string, CheckoutServices>();
const sellerOrders = new Map<string, SellerOrdersServices>();
const sellerInventories = new Map<string, SellerInventoryServices>();
const sellerFinances = new Map<string, SellerFinanceServices>();
const admins = new Map<string, AdminServices>();
const postOrder = new Map<string, PostOrderServices>();
const killSwitches = new FlagService({ store: new PostgresFlagStore(appClient), audit: { record: () => Promise.resolve() } });
for (const m of listMarkets()) {
  const marketId = m.id.toUpperCase();
  const audience = `outlet:${m.id}`;
  // Token verification never touches the database; session issue/refresh (auth routes, later) use the auth pool.
  const sessions = new SessionService(authClient, { marketId, issuer: env.JWT_ISSUER, audience, kid: env.JWT_KID, privateKey, publicKey, refreshGraceKey: authDeps.hasher.hmac("refresh-grace-key", "v1") });
  verifiers.set(marketId, { audience, verifyAccessToken: (jwt, now) => sessions.verifyAccessToken(jwt, now) });
  const hasher = authDeps.hasher;
  // Credentials persist in passkey_credentials (migration 0020) through the outlet_auth pool, so passkeys need DATABASE_URL_AUTH and a configured relying
  // party; otherwise fail closed (503). Ceremony challenges live in passkey_challenges (migration 0024), shared by every instance: passkeys may be enabled only with
  // this store (docs/compliance/verify-register.md).
  const origins = env.PASSKEY_ORIGINS.split(",").map((o) => o.trim()).filter((o) => o.length > 0);
  const passkeys =
    env.PASSKEY_RP_ID !== undefined && origins.length > 0 && authPool !== undefined
      ? new WebAuthnPasskeys({ marketId, rpName: "Outlex", rpId: env.PASSKEY_RP_ID, origins, challengeTtlMs: 5 * 60_000, now: () => new Date(), userLabel: pgPhoneLabel(appClient, marketId, authDeps.cipher) }, new PgPasskeyStore(brandClient<"outlet_auth">(authClient)), new PgChallengeStore(brandClient<"outlet_auth">(authClient)))
      : new UnconfiguredPasskeys();
  auths.set(marketId, {
    otp: new OtpService(authClient, authDeps, new PgRateLimiter(authClient, marketId), new UnconfiguredSms()),
    sessions,
    sessionReader: new SessionReader(appClient, marketId),
    devices: { register: (i) => registerDevice(authClient, hasher, { marketId, platform: i.platform, installId: i.installId, now: i.now }) },
    oidc: new UnconfiguredOidc(),
    // No Turnstile / App Attest verifier is contracted yet: device registration fails closed (503) until one is wired (ADR-0029).
    attestation: new UnconfiguredDeviceAttestation(),
    passkeys,
  });
  carts.set(marketId, { cart: new CartService({ client: appClient, marketId, availability: pgInventoryAvailability(appClient, marketId) }), suggestions: noSuggestions });
  const provider = new UnconfiguredPaymentProvider();
  const ports = {
    config: productionCheckoutConfig(),
    reservations: new ReservationService({ client: appClient, marketId }),
    provider,
    shipping: new UnconfiguredShipping(),
    address: new PgAddressPort(appClient, marketId),
    commission: new UnconfiguredCommission(),
    taxCategories: new StandardTaxCategories(),
    taxRates: InMemoryTaxRateProvider.withMarketDefaults([m.id]),
    credit: new PgStoreCredit("EGP"),
    tokens: quoteTokens,
    prices: new PlainPrices(),
    killSwitches: new FlagKillSwitches(killSwitches, marketId),
    subMerchants: new UnconfiguredSubMerchants(),
    billing: new UnconfiguredBilling(),
    refunds: new UnconfiguredRefunds(),
    marketId,
    // Promotions fail closed (failed or killed flag read = no discount); the reinstate gate reads the shopper's own seller orders. Delivery snapshots freeze the address per seller order at placement.
    promotions: productionPromotionsPort(appClient, marketId, killSwitches),
    addressSnapshots: new AddressService({ client: appClient, marketId }, authDeps.cipher),
  };
  const workerClient = authPoolWorker === undefined ? undefined : pgSqlClient<"outlet_worker">(authPoolWorker);
  checkouts.set(marketId, {
    checkout: new CheckoutService({ ...ports, client: appClient }),
    webhooks: workerClient === undefined
      ? { handle: () => Promise.reject(Problems.unavailable("webhooks-unavailable")) }
      : new WebhookProcessor({ ...ports, client: workerClient, cipher: new AesRawBodyCipher(rawKey) }),
    orders: new OrderGroupReader(appClient, marketId),
    // No confirmation channel (WhatsApp/SMS/IVR) is configured: no code is valid.
    cod: unconfiguredCodConfirmation,
    provider: "paymob",
  });
  // Courier contract and the addresses table do not exist yet (V33/V43): shipping fails closed (503) and no buyer delivery data is shown.
  const cancellation = provider instanceof UnconfiguredPaymentProvider ? undefined : productionOrderCancellation({ client: appClient, marketId, reservations: ports.reservations, provider, credit: ports.credit, vouchers: ports.promotions, log: logger });
  sellerOrders.set(marketId, {
    orders: new SellerOrderService({
      client: appClient, marketId, now: () => new Date(), newId: uuidv7, outbox: new OutboxWriter(pgTransactionalWriter),
      delivery: new UnconfiguredBuyerDelivery(), courier: new UnconfiguredCourier(), paymentKinds: new PgPaymentKind(appClient, marketId), courierCode: "bosta", serviceLevel: "standard", cancellation,
    }),
  });
  sellerInventories.set(marketId, { inventory: new SellerInventoryService({ client: appClient, marketId, inventory: new InventoryService({ client: appClient, marketId }), newId: uuidv7, now: () => new Date() }) });
  sellerFinances.set(marketId, { finance: new SellerFinanceService({ client: appClient, marketId, currency: "EGP", now: () => new Date() }) });
  // Admin Console. Approvals use the app pool; KYC and reconciliation reads run as named worker jobs, so without DATABASE_URL_WORKER they stay 503. Audited staff writes append to the Postgres hash chain (outlet_app, same transaction); dual approval is required at every amount (threshold 0) until finance sets one.
  const auditPort = new PgAuditStore(appClient);
  const kycOnboarding = workerClient === undefined ? undefined : new SellerOnboardingService({ app: appClient, auth: brandClient<"outlet_auth">(authClient), worker: workerClient, marketId, cipher: authDeps.cipher, hasher: authDeps.hasher }, new UnconfiguredKycCheck());
  const adminAccess = createAdminAccess({ db: appClient, audit: auditPort, clock: () => new Date(), thresholdMinor: 0n });
  admins.set(marketId, workerClient === undefined || kycOnboarding === undefined
    ? unconfiguredAdminServices
    : {
        access: adminAccess,
        // Store suspend / reinstate need the seller.kyc worker job (seller and KYC case) and the store context (stores + public read model); without DATABASE_URL_WORKER the whole console is 503.
        ops: {
          flags: new FlagAdmin(appClient, auditPort), audit: new PgAuditReader(appClient), elevations: new PgElevationReader(appClient), piiAccess: new PgPiiAccessReader(appClient),
          stores: new StoreModeration({ stores: new StoreService({ client: appClient, marketId }), sellers: kycOnboarding, audit: auditPort }),
          // Attention queue (outlet_app, user context; every write audits in its own transaction). The Home dashboard reads the rollups as the admin.dashboard worker job; until the
          // reporting.rollup job has run, snapshot and sales tiles answer unavailable/not_connected (never zero), and cod_unremitted / ledger_integrity stay not connected.
          attention: new AttentionAdmin(appClient, auditPort),
          // Relay DLQ replay / discard run as the outbox.relay worker job (worker pool); inside this branch the worker pool exists, otherwise the whole console is 503.
          dlq: new DlqAdmin(workerClient, appClient, auditPort),
          // Refunds / returns / disputes lists read as finance.refunds, payouts as finance.payouts (existing worker policies, no new grant). Hold / release reuse PayoutService (state machine,
          // version lock, outbox) with the rail and destinations Unconfigured: neither is reachable from hold or release, so no money can move from this path.
          lists: new PgOpsLists(workerClient),
          payouts: new PayoutsAdmin(new PayoutService({ client: workerClient, currency: "EGP", now: () => new Date(), admin: adminAccess, rail: new UnconfiguredPayoutRail(), destinations: new UnconfiguredPayoutDestinations(), audit: { append: () => Promise.resolve() } }), appClient, auditPort),
        },
        dashboard: new PgDashboardReader(workerClient),
        approvals: new PgApprovalReader(appClient),
        kyc: new PgKycAdmin(workerClient, kycOnboarding),
        reconciliation: new PgReconciliationReader(workerClient),
      });
  // Addresses, returns, tracking and the seller application. Courier, return evidence, cancellation saga and KYC provider stay unconfigured and fail closed (ADR-0029).
  postOrder.set(marketId, postOrderServices({
    marketId, appClient, authClient: brandClient<"outlet_auth">(authClient), workerClient, cipher: authDeps.cipher, hasher: authDeps.hasher,
    cancellation,
    delivery: workerClient === undefined ? undefined : new OrderCloseJob({ ...ports, client: workerClient, cipher: new AesRawBodyCipher(rawKey) }),
  }));
  const deps: CatalogDeps = { client: appClient, marketId };
  catalogs.set(marketId, {
    publicCatalog: new PublicCatalogService(deps),
    defects: new DefectService(deps),
    listings: new ListingService(deps),
    variants: new VariantService(deps),
    attributeSets: new AttributeSetReader({ client: appClient, marketId }),
    // Object storage and the AV scanner are provider contracts (ADR-0029): until configured, uploads fail closed with 503.
    media: { ingest: () => Promise.reject(new MediaError("av_unavailable", "media storage is not configured")) },
    discovery: new DiscoveryReader({ client: appClient, marketId }),
    // Fail closed: an unreadable Price Watch switch counts as killed, so no band is ever shown without it.
    deals: new DealsReader({ client: appClient, marketId, now: () => new Date(), priceWatchKilled: () => killSwitches.isKilled(PRICE_WATCH_KILL_SWITCH, { marketId }).catch(() => true) }),
  });
}

const postOrderOf = (marketId: string): PostOrderServices => {
  const c = postOrder.get(marketId);
  if (c === undefined) throw new Error("market not configured");
  return c;
};

const redis = env.REDIS_URL === undefined ? undefined : new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 1_000 });
const lifecycle = { draining: false };
const deps: ApiDeps = {
  http: { bodyLimitBytes: 1024 * 1024, requestTimeoutMs: 10_000, trustProxy: trustProxyList(env.TRUST_PROXY), trustAsnHeader: env.TRUST_ASN_HEADER, rateLimitKeySecret: env.RATE_LIMIT_KEY_SECRET },
  clock: systemClock,
  logger,
  appClient,
  tokens: new SessionTokenVerifier(verifiers),
  memberships: new UnconfiguredStoreMemberships(),
  rateLimiter: redis === undefined ? new MemoryRateLimiter() : new RedisRateLimiter(redis),
  idempotency: new IdempotencyStore(appClient),
  killSwitches,
  catalog: (marketId) => {
    const c = catalogs.get(marketId);
    if (c === undefined) throw new Error("market not configured");
    return c;
  },
  auth: (marketId) => {
    const a = auths.get(marketId);
    if (a === undefined) throw new Error("market not configured");
    return a;
  },
  cart: (marketId) => {
    const c = carts.get(marketId);
    if (c === undefined) throw new Error("market not configured");
    return c;
  },
  checkout: (marketId) => {
    const c = checkouts.get(marketId);
    if (c === undefined) throw new Error("market not configured");
    return c;
  },
  sellerOrders: (marketId) => {
    const c = sellerOrders.get(marketId);
    if (c === undefined) throw new Error("market not configured");
    return c;
  },
  addresses: (marketId) => postOrderOf(marketId).addresses,
  returns: (marketId) => postOrderOf(marketId).returns,
  tracking: (marketId) => postOrderOf(marketId).tracking,
  sellerOnboarding: (marketId) => postOrderOf(marketId).sellerOnboarding,
  sellerInventory: (marketId) => {
    const c = sellerInventories.get(marketId);
    if (c === undefined) throw new Error("market not configured");
    return c;
  },
  sellerFinance: (marketId) => {
    const c = sellerFinances.get(marketId);
    if (c === undefined) throw new Error("market not configured");
    return c;
  },
  admin: (marketId) => {
    const c = admins.get(marketId);
    if (c === undefined) throw new Error("market not configured");
    return c;
  },
  // Deny-all until PSP_WEBHOOK_IPS names the provider's published addresses.
  webhookIps: Object.keys(parseWebhookIps(env.PSP_WEBHOOK_IPS)).length === 0 ? denyAllWebhookIps : staticWebhookIps(parseWebhookIps(env.PSP_WEBHOOK_IPS)),
  lifecycle,
};

const { app } = await createApp(deps);
await app.listen({ host: env.HOST, port: env.PORT });
logger.info("api listening", { port: env.PORT });

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  logger.info("draining", { signal });
  lifecycle.draining = true;
  await new Promise((r) => setTimeout(r, env.DRAIN_MS));
  await app.close();
  await Promise.allSettled([pool.end(), authPool?.end(), authPoolWorker?.end(), redis?.quit(), telemetry.shutdown()]);
  logger.info("stopped");
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
