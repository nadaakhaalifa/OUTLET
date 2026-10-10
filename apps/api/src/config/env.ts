import { z } from "zod";

/**
 * Environment configuration, parsed once at boot. Everything is validated; nothing reads
 * `process.env` anywhere else. Secrets are never defaulted in production.
 */
const NodeEnvSchema = z.enum(["development", "test", "production"]);

const RawEnvSchema = z.object({
  NODE_ENV: NodeEnvSchema.default("development"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  /** Token issuer claim. */
  TOKEN_ISSUER: z.string().min(1).max(200).default("outlet-nk-api"),
  /** Number of reverse proxy hops to trust for client IP (0 = none). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /** Use in-memory development fixtures. Defaults to true outside production; refused in production. */
  DEV_FIXTURES: z.stringbool().optional(),
  /** HMAC pepper for OTP hashes. Required in production, generated per boot in development. */
  OTP_PEPPER: z.string().min(32).max(256).optional(),
  /** HMAC key for IP hashes stored with consent records. */
  IP_HASH_KEY: z.string().min(32).max(256).optional(),
  /** Version of the consent texts currently shown (applies to every purpose until texts diverge). */
  CONSENT_TEXT_VERSION: z.coerce.number().int().min(1).max(10_000).default(1),
});

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[],
  ) {
    super(`${message}: ${issues.join("; ")}`);
    this.name = "ConfigError";
  }
}

export interface AppConfig {
  readonly env: z.infer<typeof NodeEnvSchema>;
  readonly port: number;
  readonly tokenIssuer: string;
  readonly trustProxyHops: number;
  /** "in-memory-dev" is the only adapter set that exists. Production has none yet. */
  readonly adapters: "in-memory-dev" | "production";
  readonly otpPepper: string | undefined;
  readonly ipHashKey: string | undefined;
  readonly consentTextVersion: number;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const parsed = RawEnvSchema.safeParse(env);
  if (!parsed.success) {
    // Names of the failing variables only, never their values (they may be secrets).
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`);
    throw new ConfigError("invalid environment configuration", issues);
  }
  const raw = parsed.data;
  const production = raw.NODE_ENV === "production";
  const devFixtures = raw.DEV_FIXTURES ?? !production;
  const issues: string[] = [];
  if (production && devFixtures) issues.push("DEV_FIXTURES: in-memory fixtures are refused in production");
  if (production && raw.OTP_PEPPER === undefined) issues.push("OTP_PEPPER: required in production");
  if (production && raw.IP_HASH_KEY === undefined) issues.push("IP_HASH_KEY: required in production");
  if (issues.length > 0) throw new ConfigError("invalid environment configuration", issues);
  return {
    env: raw.NODE_ENV,
    port: raw.PORT,
    tokenIssuer: raw.TOKEN_ISSUER,
    trustProxyHops: raw.TRUST_PROXY_HOPS,
    adapters: devFixtures ? "in-memory-dev" : "production",
    otpPepper: raw.OTP_PEPPER,
    ipHashKey: raw.IP_HASH_KEY,
    consentTextVersion: raw.CONSENT_TEXT_VERSION,
  };
}
