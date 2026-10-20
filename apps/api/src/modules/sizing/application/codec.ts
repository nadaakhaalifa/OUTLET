import type { FieldCipherPort, ProfileKind, ProfileRecord } from "../domain/ports";
import type { Measurements } from "../domain/bridge";
import { ProblemError } from "../../../platform/problem";

export interface UsualSize {
  readonly brandId: string | null;
  readonly sizeLabel: string;
}

/** Decrypted profile. Exists only inside a request, never persisted, logged or sent to a seller. */
export interface ProfileView {
  readonly id: string;
  readonly label: string;
  readonly kind: ProfileKind;
  readonly fitPreference: ProfileRecord["fitPreference"];
  readonly modestFit: boolean;
  readonly measurements: Measurements | null;
  readonly usualSize: UsualSize | null;
  readonly version: number;
  readonly updatedAtMs: number;
}

export class CipherUnavailableError extends Error {
  constructor() {
    super("field cipher unavailable");
    this.name = "CipherUnavailableError";
  }
}

/** Stored ciphertext is malformed or failed authentication: an integrity fault, not an outage. Never retry-as-503. */
export class CiphertextIntegrityError extends Error {
  constructor() {
    super("field ciphertext integrity failure");
    this.name = "CiphertextIntegrityError";
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const aad = (userId: string, profileId: string, field: "label" | "measurements" | "quick_start"): string =>
  `size_profile:${userId}:${profileId}:${field}`;

function mapFailure(e: unknown): never {
  // A typed Problem (503 provider_not_configured from an Unconfigured KMS) reaches the client as is.
  if (e instanceof ProblemError) throw e;
  if (e instanceof Error && e.message === "bad_ciphertext") throw new CiphertextIntegrityError();
  throw new CipherUnavailableError();
}

/** Single place where P3 profile fields cross the encryption boundary. */
export class ProfileCodec {
  constructor(private readonly cipher: FieldCipherPort) {}

  async seal(
    userId: string,
    id: string,
    parts: { label: string; measurements: Measurements | null; usualSize: UsualSize | null },
  ): Promise<Pick<ProfileRecord, "labelEnc" | "measurementsEnc" | "quickStartEnc">> {
    try {
      return {
        labelEnc: await this.cipher.encrypt(enc.encode(parts.label), aad(userId, id, "label")),
        measurementsEnc:
          parts.measurements === null
            ? null
            : await this.cipher.encrypt(enc.encode(JSON.stringify(parts.measurements)), aad(userId, id, "measurements")),
        quickStartEnc:
          parts.usualSize === null
            ? null
            : await this.cipher.encrypt(
                enc.encode(JSON.stringify({ b: parts.usualSize.brandId, s: parts.usualSize.sizeLabel })),
                aad(userId, id, "quick_start"),
              ),
      };
    } catch (e) {
      mapFailure(e);
    }
  }

  async open(r: ProfileRecord): Promise<ProfileView> {
    try {
      const label = dec.decode(await this.cipher.decrypt(r.labelEnc, aad(r.userId, r.id, "label")));
      const measurements =
        r.measurementsEnc === null
          ? null
          : (JSON.parse(dec.decode(await this.cipher.decrypt(r.measurementsEnc, aad(r.userId, r.id, "measurements")))) as Measurements);
      let usualSize: UsualSize | null = null;
      if (r.quickStartEnc !== null) {
        const q = JSON.parse(dec.decode(await this.cipher.decrypt(r.quickStartEnc, aad(r.userId, r.id, "quick_start")))) as {
          b: string | null;
          s: string;
        };
        usualSize = { brandId: q.b, sizeLabel: q.s };
      }
      return {
        id: r.id,
        label,
        kind: r.kind,
        fitPreference: r.fitPreference,
        modestFit: r.modestFit,
        measurements,
        usualSize,
        version: r.version,
        updatedAtMs: r.updatedAtMs,
      };
    } catch (e) {
      mapFailure(e);
    }
  }
}
