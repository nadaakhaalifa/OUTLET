import { DecryptCommand, DescribeKeyCommand, EncryptCommand, GenerateMacCommand, type KMSClient } from "@aws-sdk/client-kms";
import { EnvelopeFieldCipher, type KmsPort } from "../../../modules/sizing/adapters/envelope-cipher";
import type { FieldCipher } from "../../../modules/auth/domain/ports";
import { callAws, probe } from "./errors";
import { ProviderUnavailableError } from "./errors";

export interface KmsSettings {
  readonly keyId: string;
  readonly keyVersion: number;
  readonly hmacKeyId: string;
  readonly probeTimeoutMs?: number;
}

const enc = new TextEncoder();

/**
 * AWS KMS implementation of KmsPort. The data key is generated locally by EnvelopeFieldCipher and
 * wrapped with KMS Encrypt, with the field AAD bound as the KMS encryption context. The wrapped key
 * records the RESOLVED key ARN (an alias resolves at wrap time), so decrypt targets the exact key
 * that wrapped it; `keyVersion` tracks alias repoints (KMS_KEY_VERSION). Auto-rotation of the
 * backing key material is transparent to Decrypt.
 */
export class AwsKmsPort implements KmsPort {
  constructor(
    private readonly client: Pick<KMSClient, "send">,
    private readonly s: KmsSettings,
    private readonly sleep?: (ms: number) => Promise<void>,
  ) {}

  async wrapKey(dek: Uint8Array, context: string) {
    const r = await callAws("kms.envelope", "wrapKey", () => this.client.send(new EncryptCommand({ KeyId: this.s.keyId, Plaintext: dek, EncryptionContext: { ctx: context } })), {
      idempotent: true,
      ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
    });
    if (r.CiphertextBlob === undefined || r.KeyId === undefined) throw new ProviderUnavailableError("kms.envelope", "wrapKey");
    return { keyId: r.KeyId, keyVersion: this.s.keyVersion, wrapped: new Uint8Array(r.CiphertextBlob) };
  }

  async unwrapKey(i: { keyId: string; keyVersion: number; wrapped: Uint8Array; context: string }): Promise<Uint8Array> {
    const r = await callAws("kms.envelope", "unwrapKey", () => this.client.send(new DecryptCommand({ KeyId: i.keyId, CiphertextBlob: i.wrapped, EncryptionContext: { ctx: i.context } })), {
      idempotent: true,
      ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
    });
    if (r.Plaintext === undefined) throw new ProviderUnavailableError("kms.envelope", "unwrapKey");
    return new Uint8Array(r.Plaintext);
  }

  async hmac(purpose: string, data: Uint8Array): Promise<Uint8Array> {
    const msg = Buffer.concat([enc.encode(purpose), Buffer.from([0]), data]);
    const r = await callAws("kms.envelope", "hmac", () => this.client.send(new GenerateMacCommand({ KeyId: this.s.hmacKeyId, Message: msg, MacAlgorithm: "HMAC_SHA_256" })), {
      idempotent: true,
      ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
    });
    if (r.Mac === undefined) throw new ProviderUnavailableError("kms.envelope", "hmac");
    return new Uint8Array(r.Mac);
  }

  /** Readiness: DescribeKey on the master key. */
  ready(): Promise<boolean> {
    return probe((signal) => this.client.send(new DescribeKeyCommand({ KeyId: this.s.keyId }), { abortSignal: signal }), this.s.probeTimeoutMs ?? 2000);
  }
}

/**
 * Production auth FieldCipher on top of any KmsPort: AES-256-GCM per-record envelope, 32-byte blind
 * indexes from the KMS HMAC key. Replaces LocalKeyFieldCipher (ciphertext formats are NOT
 * interchangeable; see docs/engineering/aws-adapters.md for the migration note).
 */
export class KmsFieldCipher implements FieldCipher {
  private readonly envelope: EnvelopeFieldCipher;
  constructor(private readonly kms: KmsPort) {
    this.envelope = new EnvelopeFieldCipher(kms);
  }
  encrypt(plaintext: string, aad: string): Promise<Uint8Array> {
    return this.envelope.encrypt(enc.encode(plaintext), aad);
  }
  async decrypt(ciphertext: Uint8Array, aad: string): Promise<string> {
    return new TextDecoder().decode(await this.envelope.decrypt(ciphertext, aad));
  }
  blindIndex(purpose: string, value: string): Promise<Uint8Array> {
    return this.kms.hmac(purpose, enc.encode(value));
  }
  /** The byte-level envelope, for ports that decrypt raw bytes (sizing, privacy exporters). */
  get bytes(): EnvelopeFieldCipher {
    return this.envelope;
  }
}
