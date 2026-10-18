import { z } from "zod";

/**
 * Optional AWS-compatible provider configuration. Region-agnostic (ADR-0032): the region comes from
 * the environment and is never defaulted. Credentials come from the default AWS provider chain
 * (IAM role / OIDC), never from application env vars.
 */
const bool = z.stringbool().optional();
const Raw = z.object({
  AWS_REGION: z.string().min(1).max(40).optional(),
  S3_BUCKET: z.string().min(3).max(63).optional(),
  /** Any S3-compatible endpoint (MinIO, Egypt-hosted provider). */
  S3_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: bool,
  /** SSE-KMS key id/ARN/alias for objects. Required with S3_BUCKET unless S3_ALLOW_SSE_S3 is true. */
  S3_KMS_KEY_ID: z.string().min(1).max(2048).optional(),
  S3_ALLOW_SSE_S3: bool,
  /** Master key (id, ARN or alias) used to wrap field data keys. */
  KMS_KEY_ID: z.string().min(1).max(2048).optional(),
  /** Bump when the alias is repointed to a new key, so stored ciphertexts record which generation wrapped them. */
  KMS_KEY_VERSION: z.coerce.number().int().min(1).max(1_000_000).default(1),
  /** HMAC_256 KMS key for blind indexes. */
  KMS_HMAC_KEY_ID: z.string().min(1).max(2048).optional(),
  /** Secrets Manager id holding the token signing key set JSON ({activeKid, keys[]}). */
  SECRETS_TOKEN_KEYS_ID: z.string().min(1).max(2048).optional(),
  /** Secrets Manager id of the waiting-room admission signing key set JSON ({activeKid, keys:[{kid,key(base64)}]}). */
  SECRETS_ADMISSION_KEYS_ID: z.string().min(1).max(2048).optional(),
  /** Secrets Manager id of the analytics pseudonym keys JSON ({current:{kid,shopperKey,termKey},previous?}, base64, 32+ bytes each). Optional: absent = Unconfigured. Never printed. */
  SECRETS_ANALYTICS_KEYS_ID: z.string().min(1).max(2048).optional(),
  SECRETS_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(3600).default(300),
  AWS_PROBE_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2000),
});

export interface AwsConfig {
  readonly region: string | undefined;
  readonly probeTimeoutMs: number;
  readonly s3: { readonly bucket: string; readonly endpoint: string | undefined; readonly forcePathStyle: boolean; readonly kmsKeyId: string | undefined } | null;
  readonly kms: { readonly keyId: string; readonly keyVersion: number; readonly hmacKeyId: string } | null;
  readonly secrets: { readonly tokenKeysId: string; readonly admissionKeysId: string | undefined; readonly analyticsKeysId: string | undefined; readonly cacheTtlSeconds: number } | null;
}

/** Returns the config plus validation issues (variable names only, never values). */
export function parseAwsEnv(env: Readonly<Record<string, string | undefined>>): { readonly config: AwsConfig; readonly issues: readonly string[] } {
  const p = Raw.safeParse(env);
  const empty: AwsConfig = { region: undefined, probeTimeoutMs: 2000, s3: null, kms: null, secrets: null };
  if (!p.success) return { config: empty, issues: p.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`) };
  const r = p.data;
  const issues: string[] = [];
  const hasRegion = r.AWS_REGION !== undefined;
  let s3: AwsConfig["s3"] = null;
  if (r.S3_BUCKET !== undefined) {
    if (!hasRegion && r.S3_ENDPOINT === undefined) issues.push("AWS_REGION: required with S3_BUCKET");
    else if (r.S3_KMS_KEY_ID === undefined && r.S3_ALLOW_SSE_S3 !== true) issues.push("S3_KMS_KEY_ID: required with S3_BUCKET (SSE-KMS)");
    else s3 = { bucket: r.S3_BUCKET, endpoint: r.S3_ENDPOINT, forcePathStyle: r.S3_FORCE_PATH_STYLE ?? r.S3_ENDPOINT !== undefined, kmsKeyId: r.S3_KMS_KEY_ID };
  }
  let kms: AwsConfig["kms"] = null;
  if (r.KMS_KEY_ID !== undefined || r.KMS_HMAC_KEY_ID !== undefined) {
    if (r.KMS_KEY_ID === undefined || r.KMS_HMAC_KEY_ID === undefined) issues.push("KMS_KEY_ID and KMS_HMAC_KEY_ID: both required");
    else if (!hasRegion) issues.push("AWS_REGION: required with KMS_KEY_ID");
    else kms = { keyId: r.KMS_KEY_ID, keyVersion: r.KMS_KEY_VERSION, hmacKeyId: r.KMS_HMAC_KEY_ID };
  }
  let secrets: AwsConfig["secrets"] = null;
  if (r.SECRETS_TOKEN_KEYS_ID !== undefined) {
    if (!hasRegion) issues.push("AWS_REGION: required with SECRETS_TOKEN_KEYS_ID");
    else secrets = { tokenKeysId: r.SECRETS_TOKEN_KEYS_ID, admissionKeysId: r.SECRETS_ADMISSION_KEYS_ID, analyticsKeysId: r.SECRETS_ANALYTICS_KEYS_ID, cacheTtlSeconds: r.SECRETS_CACHE_TTL_SECONDS };
  }
  return { config: { region: r.AWS_REGION, probeTimeoutMs: r.AWS_PROBE_TIMEOUT_MS, s3, kms, secrets }, issues };
}
