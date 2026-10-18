import type { ReadinessCheck } from "../../../platform/ports";
import type { RedisConfig } from "./config";
import { RedisConnection } from "./connection";
import { RedisFlagProvider } from "./flag-provider";
import { RedisWaitingQueue, RedisSingleUseTokens } from "./queue";
import { RedisRateLimiter } from "./rate-limiter";
import { RedisCache } from "./cache";
import { RedisSoldOutFlags } from "./sold-out";

export * from "./cache";
export * from "./config";
export * from "./connection";
export * from "./flag-provider";
export * from "./queue";
export * from "./rate-limiter";
export * from "./sold-out";

export interface RedisAdapters {
  readonly conn: RedisConnection;
  readonly rateLimiter: RedisRateLimiter;
  readonly queue: RedisWaitingQueue;
  readonly admissionTokens: RedisSingleUseTokens;
  readonly soldOut: RedisSoldOutFlags;
  readonly cache: RedisCache;
  readonly flagProvider: RedisFlagProvider;
  /** Informational for /v1/ready. Redis down must NOT fail readiness: checkout keeps working without it. */
  readonly readiness: ReadinessCheck;
  describe(): Promise<{ readonly redis: "configured_reachable" | "configured_unreachable" }>;
  close(): Promise<void>;
}

export function createRedisAdaptersFromConnection(conn: RedisConnection): RedisAdapters {
  return {
    conn,
    rateLimiter: new RedisRateLimiter(conn),
    queue: new RedisWaitingQueue(conn),
    admissionTokens: new RedisSingleUseTokens(conn),
    soldOut: new RedisSoldOutFlags(conn),
    cache: new RedisCache(conn),
    flagProvider: new RedisFlagProvider(conn),
    readiness: {
      name: "redis",
      check: async () => {
        await conn.ping(); // refreshes breaker state and metrics; the result is reported by describe(), never gating
        return true;
      },
    },
    describe: async () => ({ redis: (await conn.ping()) ? "configured_reachable" : "configured_unreachable" }),
    close: () => conn.close(),
  };
}

const singletons = new Map<string, RedisAdapters>();

/** Process-wide adapters for a config (one connection shared by ports.ts and compose.ts). Undefined when REDIS_URL is unset. */
export function getRedisAdapters(cfg: RedisConfig | undefined): RedisAdapters | undefined {
  if (cfg === undefined) return undefined;
  const id = `${cfg.url}|${cfg.keyPrefix}`;
  let a = singletons.get(id);
  if (a === undefined) {
    a = createRedisAdaptersFromConnection(RedisConnection.fromConfig(cfg));
    singletons.set(id, a);
  }
  return a;
}

export async function closeRedisAdapters(): Promise<void> {
  const all = [...singletons.values()];
  singletons.clear();
  await Promise.all(all.map((a) => a.close()));
}
