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
import { Redis } from "ioredis";
import pg from "pg";
import { createApp } from "./app.js";
import { parseEnv, trustProxyList } from "./config.js";
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
const appClient = pgSqlClient(pool as unknown as PoolLike);

const privateKey = createPrivateKey(env.JWT_PRIVATE_KEY_PEM).toCryptoKey("ES256", false, ["sign"]);
const publicKey = createPublicKey(env.JWT_PUBLIC_KEY_PEM).toCryptoKey("ES256", true, ["verify"]);
const verifiers = new Map<string, MarketTokenService>();
const catalogs = new Map<string, CatalogServices>();
for (const m of listMarkets()) {
  const marketId = m.id.toUpperCase();
  const audience = `outlet:${m.id}`;
  // Token verification never touches the database; the auth routes (later) get the outlet_auth pool.
  const sessions = new SessionService(appClient, { marketId, issuer: env.JWT_ISSUER, audience, kid: env.JWT_KID, privateKey, publicKey });
  verifiers.set(marketId, { audience, verifyAccessToken: (jwt, now) => sessions.verifyAccessToken(jwt, now) });
  const deps: CatalogDeps = { client: appClient, marketId };
  catalogs.set(marketId, { publicCatalog: new PublicCatalogService(deps), defects: new DefectService(deps), listings: new ListingService(deps) });
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
  killSwitches: new FlagService({ store: new PostgresFlagStore(appClient), audit: { record: () => Promise.resolve() } }),
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
  await Promise.allSettled([pool.end(), redis?.quit(), telemetry.shutdown()]);
  logger.info("stopped");
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
