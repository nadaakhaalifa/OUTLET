import "reflect-metadata";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { SessionService } from "@outlet/auth-core";
import { DefectService, ListingService, PublicCatalogService } from "@outlet/catalog";
import type { CatalogDeps } from "@outlet/catalog";
import { FlagService, PostgresFlagStore } from "@outlet/flags";
import { IdempotencyStore } from "@outlet/idempotency";
import { createLogger } from "@outlet/logger";
import { listMarkets } from "@outlet/markets-config";
import { initTelemetry } from "@outlet/observability";
import { PRICE_WATCH_KILL_SWITCH } from "@outlet/pricing-integrity";
import { Redis } from "ioredis";
import pg from "pg";
import { createApp } from "./app.js";
import { parseEnv, trustProxyList } from "./config.js";
import { DealsReader } from "./modules/catalog-public/deals-reader.js";
import { DiscoveryReader } from "./modules/catalog-public/discovery-reader.js";
import { SessionTokenVerifier, UnconfiguredStoreMemberships } from "./platform/auth-ports.js";
import type { MarketTokenService } from "./platform/auth-ports.js";
import { pgPoolOptions, pgSqlClient } from "./platform/db.js";
import type { PoolLike } from "./platform/db.js";
import type { ApiDeps, CatalogServices } from "./platform/deps.js";
import { systemClock } from "./platform/http.js";
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
const verifiers = new Map<string, MarketTokenService>();
const catalogs = new Map<string, CatalogServices>();
const killSwitches = new FlagService({ store: new PostgresFlagStore(appClient), audit: { record: () => Promise.resolve() } });
for (const m of listMarkets()) {
  const marketId = m.id.toUpperCase();
  const audience = `outlet:${m.id}`;
  // Token verification never touches the database; session issue/refresh (auth routes, later) use the auth pool.
  const sessions = new SessionService(authClient, { marketId, issuer: env.JWT_ISSUER, audience, kid: env.JWT_KID, privateKey, publicKey });
  verifiers.set(marketId, { audience, verifyAccessToken: (jwt, now) => sessions.verifyAccessToken(jwt, now) });
  const deps: CatalogDeps = { client: appClient, marketId };
  catalogs.set(marketId, {
    publicCatalog: new PublicCatalogService(deps),
    defects: new DefectService(deps),
    listings: new ListingService(deps),
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
  await Promise.allSettled([pool.end(), authPool?.end(), redis?.quit(), telemetry.shutdown()]);
  logger.info("stopped");
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
