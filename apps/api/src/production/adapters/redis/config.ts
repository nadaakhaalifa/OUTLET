import { z } from "zod";

/**
 * Optional Redis configuration (ADR-0033). Absent REDIS_URL means every Redis-backed adapter stays
 * on its previous binding (per-process limiter, Unconfigured queue, registry-default flags).
 */
const Raw = z.object({
  REDIS_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith("redis://") || u.startsWith("rediss://"), "scheme")
    .optional(),
  /** Force TLS even for a redis:// URL (a rediss:// URL always uses TLS). */
  REDIS_TLS: z.stringbool().optional(),
  REDIS_KEY_PREFIX: z.string().regex(/^[a-z0-9:_-]{1,40}$/).default("outlet:v1"),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(50).max(10_000).default(500),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
});

export interface RedisConfig {
  readonly url: string;
  readonly tls: boolean;
  readonly keyPrefix: string;
  readonly commandTimeoutMs: number;
  readonly connectTimeoutMs: number;
}

export function parseRedisEnv(env: Readonly<Record<string, string | undefined>>): {
  readonly config: RedisConfig | undefined;
  readonly issues: readonly string[];
} {
  const p = Raw.safeParse(env);
  if (!p.success) return { config: undefined, issues: p.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`) };
  const r = p.data;
  if (r.REDIS_URL === undefined) return { config: undefined, issues: [] };
  return {
    config: {
      url: r.REDIS_URL,
      tls: r.REDIS_TLS ?? r.REDIS_URL.startsWith("rediss://"),
      keyPrefix: r.REDIS_KEY_PREFIX,
      commandTimeoutMs: r.REDIS_COMMAND_TIMEOUT_MS,
      connectTimeoutMs: r.REDIS_CONNECT_TIMEOUT_MS,
    },
    issues: [],
  };
}
