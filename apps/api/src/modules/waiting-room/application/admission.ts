import { ADMISSION_TTL_MS, checkAdmissionClaims, type AdmissionClaims } from "../domain/bridge";
import type { AdmissionCodec, AdmissionRecord, AdmissionStore, Clock, SecretPort, VerifyResult } from "../domain/ports";
import { deviceHash } from "./shared";

/** Mints the token for a stored admission. Deterministic: same record, same token. */
export async function mintToken(secrets: SecretPort, codec: AdmissionCodec, r: AdmissionRecord): Promise<string> {
  const { kid, key } = await secrets.current();
  const claims: AdmissionClaims = {
    jti: r.jti,
    dropId: r.dropId,
    userId: r.userId,
    deviceHash: r.deviceHash,
    iatMs: r.issuedAtMs,
    expMs: r.expiresAtMs,
  };
  return codec.sign(claims, kid, key);
}

/** Admission timestamps are whole seconds so the JWT round-trips exactly. */
export const admissionWindow = (nowMs: number): { issuedAtMs: number; expiresAtMs: number } => {
  const issuedAtMs = Math.floor(nowMs / 1000) * 1000;
  return { issuedAtMs, expiresAtMs: issuedAtMs + ADMISSION_TTL_MS };
};

export interface VerifyInput {
  readonly token: string;
  readonly dropId: string;
  readonly userId: string;
  readonly deviceId: string;
}

/**
 * Stateless admission check used by checkout. Signature and claims only, no queue or Redis
 * access, so purchases keep working while the waiting room is down. Single use is enforced
 * separately by `consume`, against Postgres.
 */
export class AdmissionVerifier {
  constructor(
    private readonly secrets: SecretPort,
    private readonly store: AdmissionStore,
    private readonly clock: Clock,
    private readonly codec: AdmissionCodec,
  ) {}

  async verify(i: VerifyInput): Promise<VerifyResult> {
    const p = this.codec.parse(i.token);
    if (!p.ok) return { ok: false, code: "malformed" };
    const key = await this.secrets.byKid(p.kid);
    if (key === null || !this.codec.signatureValid(p, key)) return { ok: false, code: "bad_signature" };
    const v = checkAdmissionClaims(
      p.claims,
      { dropId: i.dropId, userId: i.userId, deviceHash: deviceHash(i.deviceId) },
      this.clock.nowMs(),
    );
    return v.ok ? { ok: true, claims: p.claims } : { ok: false, code: v.code };
  }

  async consume(jti: string): Promise<"used" | "already_used" | "unknown" | "expired"> {
    return this.store.consume(jti, this.clock.nowMs());
  }
}
