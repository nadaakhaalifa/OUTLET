import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { ReadinessCheck } from "../../../platform/ports";
import type { ProviderName } from "../../unconfigured";
import type { AwsConfig } from "./config";
import { AwsKmsPort, KmsFieldCipher } from "./kms";
import { S3ObjectStore, type MetadataStripper, type VirusScanner } from "./object-store";
import { AwsSecrets, AwsSigningSecrets, AwsTokenKeySource } from "./secrets";

export * from "./config";
export * from "./errors";
export * from "./kms";
export * from "./object-store";
export * from "./secrets";

export interface AwsAdapters {
  readonly objectStore: S3ObjectStore | null;
  readonly kms: AwsKmsPort | null;
  readonly fieldCipher: KmsFieldCipher | null;
  readonly secrets: AwsSecrets | null;
  readonly tokenKeySource: AwsTokenKeySource | null;
  readonly admissionSecrets: AwsSigningSecrets | null;
  /** provider name to cheap reachability probe, for /v1/ready. */
  readonly probes: ReadonlyMap<ProviderName, () => Promise<boolean>>;
  readonly readiness: readonly ReadinessCheck[];
}

export interface AwsAdapterOptions {
  readonly scanner?: VirusScanner;
  readonly stripper?: MetadataStripper;
}

/** Builds only the adapters whose configuration is present; everything else is null (stays Unconfigured). */
export function createAwsAdapters(cfg: AwsConfig, opts: AwsAdapterOptions = {}): AwsAdapters {
  const probes = new Map<ProviderName, () => Promise<boolean>>();
  const readiness: ReadinessCheck[] = [];
  const base = cfg.region === undefined ? {} : { region: cfg.region };

  let objectStore: S3ObjectStore | null = null;
  if (cfg.s3 !== null) {
    const client = new S3Client({
      ...base,
      ...(cfg.s3.endpoint === undefined ? {} : { endpoint: cfg.s3.endpoint }),
      forcePathStyle: cfg.s3.forcePathStyle,
      maxAttempts: 1,
      // Region is required by the SigV4 signer even for custom endpoints.
      ...(cfg.region === undefined ? { region: "us-east-1" } : {}),
    });
    objectStore = new S3ObjectStore(client, { bucket: cfg.s3.bucket, kmsKeyId: cfg.s3.kmsKeyId, probeTimeoutMs: cfg.probeTimeoutMs }, client, opts.scanner, opts.stripper);
    probes.set("object.store", () => (objectStore as S3ObjectStore).ready());
  }
  let kms: AwsKmsPort | null = null;
  let fieldCipher: KmsFieldCipher | null = null;
  if (cfg.kms !== null) {
    kms = new AwsKmsPort(new KMSClient({ ...base, maxAttempts: 1 }), { ...cfg.kms, probeTimeoutMs: cfg.probeTimeoutMs });
    fieldCipher = new KmsFieldCipher(kms);
    probes.set("kms.envelope", () => (kms as AwsKmsPort).ready());
  }
  let secrets: AwsSecrets | null = null;
  let tokenKeySource: AwsTokenKeySource | null = null;
  let admissionSecrets: AwsSigningSecrets | null = null;
  if (cfg.secrets !== null) {
    secrets = new AwsSecrets(new SecretsManagerClient({ ...base, maxAttempts: 1 }), cfg.secrets.cacheTtlSeconds, Date.now, cfg.probeTimeoutMs);
    tokenKeySource = new AwsTokenKeySource(secrets, cfg.secrets.tokenKeysId);
    if (cfg.secrets.admissionKeysId !== undefined) admissionSecrets = new AwsSigningSecrets(secrets, cfg.secrets.admissionKeysId);
    const id = cfg.secrets.tokenKeysId;
    probes.set("secrets.manager", () => (secrets as AwsSecrets).ready(id));
  }
  for (const [name, fn] of probes) readiness.push({ name: `provider.${name}`, check: fn });
  return { objectStore, kms, fieldCipher, secrets, tokenKeySource, admissionSecrets, probes, readiness };
}
