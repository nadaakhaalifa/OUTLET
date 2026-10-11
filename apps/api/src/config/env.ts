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
  /** HMAC key for age-gate block identifiers (device and DOB). Required in production. */
  AGE_BLOCK_KEY: z.string().min(32).max(256).optional(),
  /** WebAuthn relying party id and the exact origin passkey responses must come from. */
  PASSKEY_RP_ID: z.string().min(1).max(253).default("outletnk.invalid"),
  PASSKEY_ORIGIN: z.string().url().default("https://outletnk.invalid"),
  /** Audience (client id) the Apple and Google ID tokens must be issued for. */
  APPLE_CLIENT_ID: z.string().min(1).max(256).default("com.outletnk.app"),
  GOOGLE_CLIENT_ID: z.string().min(1).max(256).default("outletnk-ios.apps.googleusercontent.com"),
  /** Postgres connection string (LOGIN role that is a member of app_user). Required when DEV_FIXTURES is off. */
  DATABASE_URL: z.string().url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** HMAC key that pseudonymises shopper ids in size demand events. Required when DEV_FIXTURES is off. */
  SIZE_DEMAND_PSEUDONYM_KEY: z.string().min(32).max(256).optional(),
  /** HMAC key for checkout price-lock tokens. Optional: derived from OTP_PEPPER (domain separated) when unset. */
  CHECKOUT_LOCK_SECRET: z.string().min(32).max(256).optional(),
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
  /** "in-memory-dev": fixtures. "production": Postgres stores plus Unconfigured providers (apps/api/src/production, ADR-0029). */
  readonly adapters: "in-memory-dev" | "production";
  readonly databaseUrl: string | undefined;
  readonly databasePoolMax: number;
  readonly sizeDemandPseudonymKey: string | undefined;
  readonly otpPepper: string | undefined;
  readonly ipHashKey: string | undefined;
  readonly consentTextVersion: number;
  readonly checkoutLockSecret: string | undefined;
  readonly ageBlockKey: string | undefined;
  readonly passkeyRpId: string;
  readonly passkeyOrigin: string;
  readonly appleClientId: string;
  readonly googleClientId: string;
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
  if (production && raw.AGE_BLOCK_KEY === undefined) issues.push("AGE_BLOCK_KEY: required in production");
  if (!devFixtures && raw.DATABASE_URL === undefined) issues.push("DATABASE_URL: required when DEV_FIXTURES is off");
  if (!devFixtures && raw.SIZE_DEMAND_PSEUDONYM_KEY === undefined) {
    issues.push("SIZE_DEMAND_PSEUDONYM_KEY: required when DEV_FIXTURES is off");
  }
  if (issues.length > 0) throw new ConfigError("invalid environment configuration", issues);
  return {
    env: raw.NODE_ENV,
    port: raw.PORT,
    tokenIssuer: raw.TOKEN_ISSUER,
    trustProxyHops: raw.TRUST_PROXY_HOPS,
    adapters: devFixtures ? "in-memory-dev" : "production",
    databaseUrl: raw.DATABASE_URL,
    databasePoolMax: raw.DATABASE_POOL_MAX,
    sizeDemandPseudonymKey: raw.SIZE_DEMAND_PSEUDONYM_KEY,
    otpPepper: raw.OTP_PEPPER,
    ipHashKey: raw.IP_HASH_KEY,
    consentTextVersion: raw.CONSENT_TEXT_VERSION,
    checkoutLockSecret: raw.CHECKOUT_LOCK_SECRET,
    ageBlockKey: raw.AGE_BLOCK_KEY,
    passkeyRpId: raw.PASSKEY_RP_ID,
    passkeyOrigin: raw.PASSKEY_ORIGIN,
    appleClientId: raw.APPLE_CLIENT_ID,
    googleClientId: raw.GOOGLE_CLIENT_ID,
  };
}
