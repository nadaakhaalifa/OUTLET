import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import type { TokenKeyMaterial, TokenKeySource } from "../../../modules/auth/adapters/token-service";
import type { SigningKey, SecretPort } from "../../../modules/waiting-room";
import { callAws, isMissing, mapAwsError, probe, ProviderUnavailableError } from "./errors";

export type SecretStage = "AWSCURRENT" | "AWSPREVIOUS" | "AWSPENDING";

interface CacheEntry {
  readonly value: string;
  readonly versionId: string | undefined;
  readonly expiresAtMs: number;
}

/**
 * Secrets Manager reader with a TTL cache keyed by (id, stage). Values are never logged and never
 * appear in error messages. During rotation read AWSCURRENT (active) and AWSPREVIOUS (still
 * verifying) staging labels.
 */
export class AwsSecrets {
  private readonly cache = new Map<string, CacheEntry>();
  constructor(
    private readonly client: Pick<SecretsManagerClient, "send">,
    private readonly ttlSeconds: number,
    private readonly now: () => number = Date.now,
    private readonly probeTimeoutMs = 2000,
    private readonly sleep?: (ms: number) => Promise<void>,
  ) {}

  /** Returns the secret string, or null when that stage has no version (for example no AWSPREVIOUS yet). */
  async get(secretId: string, stage: SecretStage = "AWSCURRENT"): Promise<string | null> {
    const k = `${secretId}\0${stage}`;
    const hit = this.cache.get(k);
    if (hit !== undefined && hit.expiresAtMs > this.now()) return hit.value;
    let r;
    try {
      r = await callAws("secrets.manager", "getSecret", () => this.client.send(new GetSecretValueCommand({ SecretId: secretId, VersionStage: stage })), {
        idempotent: true,
        ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
      });
    } catch (e) {
      if (isMissing(e)) {
        if (stage !== "AWSCURRENT") return null;
        throw mapAwsError("secrets.manager", "getSecret", e);
      }
      throw e;
    }
    if (r.SecretString === undefined) throw new ProviderUnavailableError("secrets.manager", "getSecret");
    this.cache.set(k, { value: r.SecretString, versionId: r.VersionId, expiresAtMs: this.now() + this.ttlSeconds * 1000 });
    return r.SecretString;
  }

  /** Version id (not the value) of the cached current secret, for audit of which version signed. */
  currentVersion(secretId: string): string | undefined {
    return this.cache.get(`${secretId}\0AWSCURRENT`)?.versionId;
  }

  invalidate(): void {
    this.cache.clear();
  }

  ready(secretId: string): Promise<boolean> {
    return probe((signal) => this.client.send(new GetSecretValueCommand({ SecretId: secretId, VersionStage: "AWSCURRENT" }), { abortSignal: signal }), this.probeTimeoutMs);
  }
}

const KeySet = z.object({ activeKid: z.string().min(1), keys: z.array(z.object({ kid: z.string().min(1) }).passthrough()).min(1).max(8) });

/** auth TokenKeySource: the secret holds the JSON key material; the token service validates it strictly. */
export class AwsTokenKeySource implements TokenKeySource {
  constructor(
    private readonly secrets: AwsSecrets,
    private readonly secretId: string,
  ) {}
  async load(): Promise<TokenKeyMaterial> {
    const raw = await this.secrets.get(this.secretId, "AWSCURRENT");
    if (raw === null) throw new ProviderUnavailableError("secrets.manager", "load");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProviderUnavailableError("secrets.manager", "load");
    }
    if (!KeySet.safeParse(parsed).success) throw new ProviderUnavailableError("secrets.manager", "load");
    return parsed as TokenKeyMaterial;
  }
}

const SigningSet = z.object({ activeKid: z.string().min(1), keys: z.array(z.object({ kid: z.string().min(1), key: z.string().min(1) })).min(1).max(8) });

/** waiting-room SecretPort: base64 HMAC keys by kid; previous version keys keep verifying during rotation. */
export class AwsSigningSecrets implements SecretPort {
  constructor(
    private readonly secrets: AwsSecrets,
    private readonly secretId: string,
  ) {}
  private async set(stage: SecretStage) {
    const raw = await this.secrets.get(this.secretId, stage);
    if (raw === null) return null;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ProviderUnavailableError("secrets.manager", "signingSet");
    }
    const p = SigningSet.safeParse(json);
    if (!p.success) throw new ProviderUnavailableError("secrets.manager", "signingSet");
    return p.data;
  }
  async current(): Promise<SigningKey> {
    const s = await this.set("AWSCURRENT");
    const k = s?.keys.find((x) => x.kid === s.activeKid);
    if (s === null || k === undefined) throw new ProviderUnavailableError("secrets.manager", "current");
    return { kid: k.kid, key: new Uint8Array(Buffer.from(k.key, "base64")) };
  }
  async byKid(kid: string): Promise<Uint8Array | null> {
    for (const stage of ["AWSCURRENT", "AWSPREVIOUS"] as const) {
      const k = (await this.set(stage))?.keys.find((x) => x.kid === kid);
      if (k !== undefined) return new Uint8Array(Buffer.from(k.key, "base64"));
    }
    return null;
  }
}
