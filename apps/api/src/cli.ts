import "reflect-metadata";
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { AesGcmFieldCipher, OtpService, PgRateLimiter, SessionService, createAuthDeps, registerDevice } from "@outlet/auth-core";
import { CartService, pgInventoryAvailability } from "@outlet/cart";
import { CheckoutService, PgStoreCredit, WebhookProcessor } from "@outlet/checkout";
import { brandClient } from "@outlet/db";
import { ReservationService } from "@outlet/inventory";
import { InMemoryTaxRateProvider } from "@outlet/tax";
import { DefectService, ListingService, PublicCatalogService, VariantService } from "@outlet/catalog";
import type { CatalogDeps } from "@outlet/catalog";
import { FlagService, PostgresFlagStore } from "@outlet/flags";
import { IdempotencyStore } from "@outlet/idempotency";
import { createLogger } from "@outlet/logger";
import { listMarkets } from "@outlet/markets-config";
import { MediaError } from "@outlet/media";
import { initTelemetry } from "@outlet/observability";
import { PRICE_WATCH_KILL_SWITCH } from "@outlet/pricing-integrity";
import { Redis } from "ioredis";
import pg from "pg";
import { createApp } from "./app.js";
import { parseEnv, parseWebhookIps, trustProxyList } from "./config.js";
import { InMemoryChallengeStore, PgPasskeyStore, SessionReader, UnconfiguredFieldCipher, UnconfiguredOidc, UnconfiguredPasskeys, UnconfiguredSms, WebAuthnPasskeys } from "./modules/auth/index.js";
import type { AuthServices } from "./modules/auth/index.js";
import { noSuggestions } from "./modules/cart/index.js";
import type { CartServices } from "./modules/cart/index.js";
import {
  AesRawBodyCipher, FlagKillSwitches, HmacQuoteTokenPort, OrderGroupReader, PlainPrices, StandardTaxCategories, UnconfiguredAddress, UnconfiguredBilling, UnconfiguredCommission,
  UnconfiguredPaymentProvider, UnconfiguredRefunds, UnconfiguredShipping, UnconfiguredSubMerchants, denyAllWebhookIps, productionCheckoutConfig, staticWebhookIps, unconfiguredCodConfirmation,
} from "./modules/checkout/index.js";
import type { CheckoutServices } from "./modules/checkout/index.js";
import { DealsReader } from "./modules/catalog-public/deals-reader.js";
import { DiscoveryReader } from "./modules/catalog-public/discovery-reader.js";
import { AttributeSetReader } from "./modules/seller-catalog/index.js";
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
const killSwitches = new FlagService({ store: new PostgresFlagStore(appClient), audit: { record: () => Promise.resolve() } });
for (const m of listMarkets()) {
  const marketId = m.id.toUpperCase();
  const audience = `outlet:${m.id}`;
  // Token verification never touches the database; session issue/refresh (auth routes, later) use the auth pool.
  const sessions = new SessionService(authClient, { marketId, issuer: env.JWT_ISSUER, audience, kid: env.JWT_KID, privateKey, publicKey });
  verifiers.set(marketId, { audience, verifyAccessToken: (jwt, now) => sessions.verifyAccessToken(jwt, now) });
  const hasher = authDeps.hasher;
  // Credentials persist in passkey_credentials (migration 0020) through the outlet_auth pool, so passkeys need DATABASE_URL_AUTH and a configured relying
  // party; otherwise fail closed (503). Ceremony challenges are still process-local (single instance): a multi-instance deployment needs a shared
  // challenge store before passkeys are switched on behind a load balancer.
  const origins = env.PASSKEY_ORIGINS.split(",").map((o) => o.trim()).filter((o) => o.length > 0);
  const passkeys =
    env.PASSKEY_RP_ID !== undefined && origins.length > 0 && authPool !== undefined
      ? new WebAuthnPasskeys({ marketId, rpName: "Outlex", rpId: env.PASSKEY_RP_ID, origins, challengeTtlMs: 5 * 60_000, now: () => new Date() }, new PgPasskeyStore(brandClient<"outlet_auth">(authClient)), new InMemoryChallengeStore())
      : new UnconfiguredPasskeys();
  auths.set(marketId, {
    otp: new OtpService(authClient, authDeps, new PgRateLimiter(authClient, marketId), new UnconfiguredSms()),
    sessions,
    sessionReader: new SessionReader(appClient, marketId),
    devices: { register: (i) => registerDevice(authClient, hasher, { marketId, platform: i.platform, installId: i.installId, now: i.now }) },
    oidc: new UnconfiguredOidc(),
    passkeys,
  });
  carts.set(marketId, { cart: new CartService({ client: appClient, marketId, availability: pgInventoryAvailability(appClient, marketId) }), suggestions: noSuggestions });
  const provider = new UnconfiguredPaymentProvider();
  const ports = {
    config: productionCheckoutConfig(),
    reservations: new ReservationService({ client: appClient, marketId }),
    provider,
    shipping: new UnconfiguredShipping(),
    address: new UnconfiguredAddress(),
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
