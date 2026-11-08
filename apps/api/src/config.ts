import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

/** Process environment, validated at boot (Zod at every boundary). Secrets come from the secrets manager as env. */
export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    /** outlet_app through PgBouncer (transaction mode), pool alias outlet_catalog (ADR-0011). */
    DATABASE_URL_APP: z.url({ protocol: /^postgres(ql)?$/ }),
    /** outlet_auth through PgBouncer (alias outlet_auth, application_name `auth`): session and auth-core paths (ADR-0011). */
    DATABASE_URL_AUTH: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
    PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    JWT_ISSUER: z.url(),
    JWT_KID: z.string().min(1).max(64),
    /** ES256 keys (SPKI / PKCS#8 PEM). The API issues tokens on /auth routes, so it holds both. */
    JWT_PUBLIC_KEY_PEM: z.string().includes("BEGIN PUBLIC KEY"),
    JWT_PRIVATE_KEY_PEM: z.string().includes("BEGIN PRIVATE KEY"),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }).optional(),
    RATE_LIMIT_KEY_SECRET: z.string().min(32),
    /** Comma-separated edge addresses/CIDRs for X-Forwarded-For; empty = trust nobody. */
    TRUST_PROXY: z.string().default(""),
    TRUST_ASN_HEADER: bool.default(false),
    OTEL_EXPORTER: z.enum(["otlp", "none"]).default("none"),
    /** How long readiness reports "draining" before the server closes (lets the balancer stop routing). */
    DRAIN_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
  })
  .refine((e) => e.NODE_ENV !== "production" || e.DATABASE_URL_AUTH !== undefined, {
    message: "DATABASE_URL_AUTH is required in production: auth paths use the outlet_auth pool, not outlet_app",
    path: ["DATABASE_URL_AUTH"],
  })
  .refine((e) => e.NODE_ENV !== "production" || e.REDIS_URL !== undefined, {
    message: "REDIS_URL is required in production: an in-memory limiter gives every instance its own budget",
    path: ["REDIS_URL"],
  });
export type Env = z.infer<typeof EnvSchema>;

/** Parses env; the error lists variable names and issue codes only (never values: they are secrets). */
export const parseEnv = (env: Readonly<Record<string, string | undefined>>): Env => {
  const r = EnvSchema.safeParse(env);
  if (!r.success) throw new Error(`invalid environment: ${r.error.issues.map((i) => `${i.path.join(".")} (${i.code})`).join(", ")}`);
  return r.data;
};

export const trustProxyList = (raw: string): string[] | false => {
  const list = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return list.length === 0 ? false : list;
};
