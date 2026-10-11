import type { FieldCipherPort, ProfileKind, ProfileRecord } from "../domain/ports";
import type { Measurements } from "../domain/bridge";

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

const enc = new TextEncoder();
const dec = new TextDecoder();

const aad = (profileId: string, field: "label" | "measurements" | "quick_start"): string =>
  `size_profile:${profileId}:${field}`;

/** Single place where P3 profile fields cross the encryption boundary. */
export class ProfileCodec {
  constructor(private readonly cipher: FieldCipherPort) {}

  async seal(
    id: string,
    parts: { label: string; measurements: Measurements | null; usualSize: UsualSize | null },
  ): Promise<Pick<ProfileRecord, "labelEnc" | "measurementsEnc" | "quickStartEnc">> {
    try {
      return {
        labelEnc: await this.cipher.encrypt(enc.encode(parts.label), aad(id, "label")),
        measurementsEnc:
          parts.measurements === null
            ? null
            : await this.cipher.encrypt(enc.encode(JSON.stringify(parts.measurements)), aad(id, "measurements")),
        quickStartEnc:
          parts.usualSize === null
            ? null
            : await this.cipher.encrypt(
                enc.encode(JSON.stringify({ b: parts.usualSize.brandId, s: parts.usualSize.sizeLabel })),
                aad(id, "quick_start"),
              ),
      };
    } catch {
      throw new CipherUnavailableError();
    }
  }

  async open(r: ProfileRecord): Promise<ProfileView> {
    try {
      const label = dec.decode(await this.cipher.decrypt(r.labelEnc, aad(r.id, "label")));
      const measurements =
        r.measurementsEnc === null
          ? null
          : (JSON.parse(dec.decode(await this.cipher.decrypt(r.measurementsEnc, aad(r.id, "measurements")))) as Measurements);
      let usualSize: UsualSize | null = null;
      if (r.quickStartEnc !== null) {
        const q = JSON.parse(dec.decode(await this.cipher.decrypt(r.quickStartEnc, aad(r.id, "quick_start")))) as {
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
    } catch {
      throw new CipherUnavailableError();
    }
  }
}
