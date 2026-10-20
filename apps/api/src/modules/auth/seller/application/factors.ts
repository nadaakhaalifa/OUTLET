import {
  MS,
  TOTP,
  checkSignCount,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  isLocked,
  otpauthUri,
  registerTotpFailure,
  totpStep,
  verifyTotp,
  RECOVERY_CODE_FORMAT,
  normalizeRecoveryCode,
  type Amr,
  type Csprng,
  type OtpChannel,
  type PasskeyVerifier,
} from "@outlet/auth-core";
import { maskPhone } from "@outlet/validation";
import type { Clock } from "../../application/common";
import type {
  SellerAuthEvents,
  SellerOtpProofStore,
  SellerPasskeyChallengeStore,
  SellerPasskeyRepository,
  SellerTotpStore,
  SellerUser,
  SellerUserDirectory,
} from "../domain/ports";
import { hashProof } from "./otp";
import type { SellerMembershipService } from "./team";
import type { IssuedSellerSession, SellerSessionIssuer, SellerSessions } from "./sessions";
import type { SellerSessionRepository } from "../domain/ports";

export const SELLER_PASSKEY_CHALLENGE_TTL_MS = 5 * MS.minute;

/** The authenticated caller of an enrolment endpoint (enrol token or full session). */
export interface SellerCaller {
  readonly sellerUserId: string;
  readonly sessionId: string;
  readonly kind: "enrol" | "full";
  readonly amr: readonly Amr[];
  readonly installId: string;
}

export interface FactorDeps {
  readonly users: SellerUserDirectory;
  readonly sessionsRepo: SellerSessionRepository;
  readonly sessions: SellerSessions;
  readonly issuer: SellerSessionIssuer;
  readonly team: SellerMembershipService;
  readonly events: SellerAuthEvents;
  readonly clock: Clock;
  readonly rng: Csprng;
  readonly newId: () => string;
}

const dedupe = (amr: readonly Amr[], add: Amr): Amr[] => [...new Set<Amr>([...amr, add])];

async function upgrade(d: FactorDeps, caller: SellerCaller, seller: SellerUser, factor: "webauthn" | "totp"): Promise<IssuedSellerSession> {
  await d.users.markStrongFactor(seller.id);
  await d.events.publish({ type: "seller.strong_factor_enrolled", sellerUserId: seller.id, method: factor, occurredAtMs: d.clock.nowMs() });
  if (caller.kind === "enrol") await d.sessions.revoke(seller.id, caller.sessionId, "user_revoked");
  // Pending staff invitations become memberships only once the strong factor exists.
  await d.team.acceptInvites(seller);
  // Keep the OTP evidence of the originating session; add the strong factor.
  const amr = dedupe(caller.amr.filter((a) => a !== "webauthn" && a !== "totp"), factor);
  return d.issuer.openFull({ sellerUserId: seller.id, installId: caller.installId, amr });
}

export type EnrolGate = { readonly ok: true; readonly seller: SellerUser } | { readonly ok: false; readonly reason: "not_found" | "already_enrolled" };

async function enrolGate(d: FactorDeps, caller: SellerCaller): Promise<EnrolGate> {
  const seller = await d.users.findById(caller.sellerUserId);
  if (seller === null || seller.status !== "active") return { ok: false, reason: "not_found" };
  // An enrol token (phone code only) never adds a second factor to an identity that has one (SIM-swap takeover).
  if (caller.kind === "enrol" && seller.strongFactor) return { ok: false, reason: "already_enrolled" };
  return { ok: true, seller };
}

// ---- Passkeys -------------------------------------------------------------------------------

export interface PasskeyConfig {
  readonly rpId: string;
  readonly rpName: string;
}

export type PasskeyRegisterOptionsResult =
  | { readonly kind: "ok"; readonly challengeId: string; readonly publicKey: Record<string, unknown> }
  | EnrolFailure;
type EnrolFailure = { readonly kind: "not_found" } | { readonly kind: "already_enrolled" };

export type PasskeyRegisterResult =
  | ({ readonly kind: "ok" } & IssuedSellerSession)
  | EnrolFailure
  | { readonly kind: "challenge_invalid" }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "already_registered" };

export type PasskeyAssertOptionsResult =
  | { readonly kind: "ok"; readonly challengeId: string; readonly publicKey: Record<string, unknown> }
  | { readonly kind: "invalid_proof" }
  | { readonly kind: "no_passkey" };

export type PasskeyAssertResult = ({ readonly kind: "ok" } & IssuedSellerSession) | { readonly kind: "rejected"; readonly reason: string };

export class SellerPasskeys {
  constructor(
    private readonly d: FactorDeps,
    private readonly verifier: PasskeyVerifier,
    private readonly challenges: SellerPasskeyChallengeStore,
    private readonly credentials: SellerPasskeyRepository,
    private readonly proofs: SellerOtpProofStore,
    private readonly cfg: PasskeyConfig,
  ) {}

  private b64url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
  }

  async registerOptions(caller: SellerCaller): Promise<PasskeyRegisterOptionsResult> {
    const gate = await enrolGate(this.d, caller);
    if (!gate.ok) return { kind: gate.reason };
    const nowMs = this.d.clock.nowMs();
    const rec = {
      id: this.d.newId(),
      challenge: this.b64url(this.d.rng.randomBytes(32)),
      purpose: "register",
      sellerUserId: gate.seller.id,
      otpChannel: null,
      expiresAtMs: nowMs + SELLER_PASSKEY_CHALLENGE_TTL_MS,
    } as const;
    await this.challenges.put(rec);
    const existing = await this.credentials.listActive(gate.seller.id);
    return {
      kind: "ok",
      challengeId: rec.id,
      publicKey: {
        rp: { id: this.cfg.rpId, name: this.cfg.rpName },
        // The user handle is the seller id; the shopper id never appears here (separate identities).
        user: { id: this.b64url(new TextEncoder().encode(gate.seller.id)), name: maskPhone(gate.seller.phoneE164), displayName: maskPhone(gate.seller.phoneE164) },
        challenge: rec.challenge,
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        timeout: SELLER_PASSKEY_CHALLENGE_TTL_MS,
        attestation: "none",
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        excludeCredentials: existing.map((c) => ({ type: "public-key", id: c.credentialId })),
      },
    };
  }

  async register(caller: SellerCaller, input: { challengeId: string; credential: unknown; label: string | null }): Promise<PasskeyRegisterResult> {
    const d = this.d;
    const gate = await enrolGate(d, caller);
    if (!gate.ok) return { kind: gate.reason };
    const nowMs = d.clock.nowMs();
    const peeked = await this.challenges.peek(input.challengeId, nowMs);
    // A challenge issued to another seller is indistinguishable from an unknown one.
    if (peeked === null || peeked.sellerUserId !== caller.sellerUserId || peeked.purpose !== "register") return { kind: "challenge_invalid" };
    const challenge = await this.challenges.take(input.challengeId, nowMs);
    if (challenge === null) return { kind: "challenge_invalid" };

    let verified;
    try {
      verified = await this.verifier.verifyRegistration({ challenge: challenge.challenge, response: input.credential });
    } catch {
      return { kind: "rejected", reason: "invalid_response" };
    }
    if (!verified.ok) return { kind: "rejected", reason: verified.reason };
    const inserted = await this.credentials.insert({
      sellerUserId: caller.sellerUserId,
      credentialId: verified.value.credentialId,
      publicKey: verified.value.publicKey,
      signCount: verified.value.signCount,
      backupEligible: verified.value.backupEligible ?? false,
      backedUp: verified.value.backedUp ?? false,
      status: "active",
      label: input.label,
      createdAtMs: nowMs,
    });
    if (!inserted) return { kind: "already_registered" };
    return { kind: "ok", ...(await upgrade(d, caller, gate.seller, "webauthn")) };
  }

  async assertOptions(otpProof: string): Promise<PasskeyAssertOptionsResult> {
    const d = this.d;
    const nowMs = d.clock.nowMs();
    const proofHash = hashProof(otpProof);
    const peek = await this.proofs.peek(proofHash, nowMs);
    if (peek === null) return { kind: "invalid_proof" };
    const creds = await this.credentials.listActive(peek.sellerUserId);
    if (creds.length === 0) return { kind: "no_passkey" };
    const proof = await this.proofs.consume(proofHash, nowMs);
    if (proof === null) return { kind: "invalid_proof" };
    const rec = {
      id: d.newId(),
      challenge: this.b64url(d.rng.randomBytes(32)),
      purpose: "assert",
      sellerUserId: proof.sellerUserId,
      otpChannel: proof.channel,
      expiresAtMs: nowMs + SELLER_PASSKEY_CHALLENGE_TTL_MS,
    } as const;
    await this.challenges.put(rec);
    return {
      kind: "ok",
      challengeId: rec.id,
      publicKey: {
        challenge: rec.challenge,
        rpId: this.cfg.rpId,
        timeout: SELLER_PASSKEY_CHALLENGE_TTL_MS,
        userVerification: "required",
        allowCredentials: creds.map((c) => ({ type: "public-key", id: c.credentialId })),
      },
    };
  }

  async assert(input: { challengeId: string; credentialId: string; credential: unknown; installId: string }): Promise<PasskeyAssertResult> {
    const d = this.d;
    const nowMs = d.clock.nowMs();
    const challenge = await this.challenges.take(input.challengeId, nowMs);
    if (challenge === null || challenge.purpose !== "assert") return { kind: "rejected", reason: "invalid_challenge" };

    const stored = await this.credentials.find(input.credentialId);
    // The credential must belong to the seller the OTP proof was issued for.
    if (stored === null || stored.status !== "active" || stored.sellerUserId !== challenge.sellerUserId) return { kind: "rejected", reason: "unknown_credential" };

    let verified;
    try {
      verified = await this.verifier.verifyAssertion({
        challenge: challenge.challenge,
        response: input.credential,
        credential: {
          credentialId: stored.credentialId,
          publicKey: stored.publicKey,
          signCount: stored.signCount,
          backupEligible: stored.backupEligible,
          backedUp: stored.backedUp,
        },
      });
    } catch {
      return { kind: "rejected", reason: "invalid_response" };
    }
    if (!verified.ok) {
      if (verified.reason === "sign_count_regression") await this.suspectClone(stored.sellerUserId, stored.credentialId);
      return { kind: "rejected", reason: verified.reason };
    }
    if (
      verified.value.credentialId !== stored.credentialId ||
      (verified.value.userHandle !== null && verified.value.userHandle !== stored.sellerUserId)
    ) {
      return { kind: "rejected", reason: "unknown_credential" };
    }
    if (verified.value.backupEligible !== undefined && verified.value.backupEligible !== stored.backupEligible) {
      return { kind: "rejected", reason: "invalid_response" };
    }
    const counter = checkSignCount(stored.signCount, verified.value.newSignCount);
    if (!counter.ok) {
      await this.suspectClone(stored.sellerUserId, stored.credentialId);
      return { kind: "rejected", reason: counter.reason };
    }
    await this.credentials.update({ ...stored, signCount: verified.value.newSignCount, backedUp: verified.value.backedUp ?? stored.backedUp });

    const seller = await d.users.findById(stored.sellerUserId);
    if (seller === null || seller.status !== "active") return { kind: "rejected", reason: "unknown_credential" };
    await d.team.acceptInvites(seller);
    const otpAmr: Amr = challenge.otpChannel === "whatsapp" ? "otp_whatsapp" : "otp_sms";
    const issued = await d.issuer.openFull({ sellerUserId: seller.id, installId: input.installId, amr: [otpAmr, "webauthn"] });
    return { kind: "ok", ...issued };
  }

  /** A rolled-back counter may mean a cloned key: disable it and end every session of the seller. */
  private async suspectClone(sellerUserId: string, credentialId: string): Promise<void> {
    const stored = await this.credentials.find(credentialId);
    if (stored !== null) await this.credentials.update({ ...stored, status: "suspected_clone" });
    await this.d.sessions.revokeAll(sellerUserId, "clone_suspected");
  }
}

// ---- TOTP -----------------------------------------------------------------------------------

export interface TotpDeps extends FactorDeps {
  readonly totp: SellerTotpStore;
  readonly proofs: SellerOtpProofStore;
  readonly pepper: Uint8Array;
  readonly issuerName: string;
}

export type TotpEnrolResult =
  | { readonly kind: "ok"; readonly otpauthUri: string; readonly recoveryCodes: readonly string[] }
  | EnrolFailure
  | { readonly kind: "already_active" };

export type TotpConfirmResult =
  | ({ readonly kind: "ok" } & IssuedSellerSession)
  | EnrolFailure
  | { readonly kind: "no_pending" }
  | { readonly kind: "invalid" }
  | { readonly kind: "locked"; readonly retryAfterMs: number };

export type TotpAssertResult =
  | ({ readonly kind: "ok"; readonly usedRecoveryCode: boolean } & IssuedSellerSession)
  | { readonly kind: "invalid_proof" }
  | { readonly kind: "invalid" }
  | { readonly kind: "locked"; readonly retryAfterMs: number };

export class SellerTotp {
  constructor(private readonly d: TotpDeps) {}

  async enrol(caller: SellerCaller): Promise<TotpEnrolResult> {
    const d = this.d;
    const gate = await enrolGate(d, caller);
    if (!gate.ok) return { kind: gate.reason };
    const secret = generateTotpSecret(d.rng);
    const codes = generateRecoveryCodes(d.rng);
    const started = await d.totp.startEnrolment(
      {
        sellerUserId: gate.seller.id,
        secretBase32: secret,
        status: "pending",
        lastUsedStep: null,
        failedCount: 0,
        lockCount: 0,
        lockedUntilMs: null,
        createdAtMs: d.clock.nowMs(),
      },
      codes.map((c) => hashRecoveryCode(c, gate.seller.id, d.pepper)),
    );
    if (!started) return { kind: "already_active" };
    return {
      kind: "ok",
      otpauthUri: otpauthUri({ issuer: d.issuerName, account: maskPhone(gate.seller.phoneE164), secretBase32: secret }),
      recoveryCodes: codes,
    };
  }

  async confirm(caller: SellerCaller, code: string): Promise<TotpConfirmResult> {
    const d = this.d;
    const gate = await enrolGate(d, caller);
    if (!gate.ok) return { kind: gate.reason };
    const rec = await d.totp.find(caller.sellerUserId);
    if (rec === null || rec.status !== "pending") return { kind: "no_pending" };
    const nowMs = d.clock.nowMs();
    const lock = { failedCount: rec.failedCount, lockCount: rec.lockCount, lockedUntilMs: rec.lockedUntilMs };
    if (isLocked(lock, nowMs)) return { kind: "locked", retryAfterMs: (rec.lockedUntilMs ?? nowMs) - nowMs };
    const check = verifyTotp({ secretBase32: rec.secretBase32, code, nowMs, lastUsedStep: rec.lastUsedStep });
    if (!check.ok) {
      await this.fail(rec.sellerUserId, lock, nowMs);
      return { kind: "invalid" };
    }
    if (!(await d.totp.acceptStep(rec.sellerUserId, check.step, rec.lastUsedStep, true, nowMs))) return { kind: "invalid" };
    await d.totp.resetFailures(rec.sellerUserId);
    return { kind: "ok", ...(await upgrade(d, caller, gate.seller, "totp")) };
  }

  /** Sign in: phone proof + TOTP code, or a single-use recovery code in the same field. */
  async assert(input: { otpProof: string; code: string; installId: string }): Promise<TotpAssertResult> {
    const d = this.d;
    const nowMs = d.clock.nowMs();
    const proofHash = hashProof(input.otpProof);
    const proof = await d.proofs.peek(proofHash, nowMs);
    if (proof === null) return { kind: "invalid_proof" };
    const rec = await d.totp.find(proof.sellerUserId);
    const seller = await d.users.findById(proof.sellerUserId);
    // No active TOTP (the seller uses a passkey, or a pending enrolment) looks like a wrong code, not a state leak.
    if (rec === null || rec.status !== "active" || seller === null || seller.status !== "active") return { kind: "invalid" };
    const lock = { failedCount: rec.failedCount, lockCount: rec.lockCount, lockedUntilMs: rec.lockedUntilMs };
    if (isLocked(lock, nowMs)) return { kind: "locked", retryAfterMs: (rec.lockedUntilMs ?? nowMs) - nowMs };

    let usedRecovery = false;
    const candidate = input.code.trim();
    if (/^[0-9]{6}$/.test(candidate)) {
      const check = verifyTotp({ secretBase32: rec.secretBase32, code: candidate, nowMs, lastUsedStep: rec.lastUsedStep });
      if (!check.ok || !(await d.totp.acceptStep(rec.sellerUserId, check.step, rec.lastUsedStep, false, nowMs))) {
        await this.fail(rec.sellerUserId, lock, nowMs);
        return { kind: "invalid" };
      }
    } else if (RECOVERY_CODE_FORMAT.test(normalizeRecoveryCode(candidate))) {
      const ok = await d.totp.consumeRecoveryCode(rec.sellerUserId, hashRecoveryCode(candidate, rec.sellerUserId, d.pepper), nowMs);
      if (!ok) {
        await this.fail(rec.sellerUserId, lock, nowMs);
        return { kind: "invalid" };
      }
      usedRecovery = true;
      await d.events.publish({
        type: "seller.recovery_code_used",
        sellerUserId: rec.sellerUserId,
        remaining: await d.totp.remainingRecoveryCodes(rec.sellerUserId),
        occurredAtMs: nowMs,
      });
    } else {
      await this.fail(rec.sellerUserId, lock, nowMs);
      return { kind: "invalid" };
    }
    // The proof is spent only now: a typo does not burn the phone verification, a lockout still bounds guessing.
    if ((await d.proofs.consume(proofHash, nowMs)) === null) return { kind: "invalid_proof" };
    await d.totp.resetFailures(rec.sellerUserId);
    await d.team.acceptInvites(seller);
    const otpAmr: Amr = proof.channel === ("whatsapp" satisfies OtpChannel) ? "otp_whatsapp" : "otp_sms";
    const issued = await d.issuer.openFull({ sellerUserId: seller.id, installId: input.installId, amr: [otpAmr, "totp"] });
    return { kind: "ok", usedRecoveryCode: usedRecovery, ...issued };
  }

  private async fail(
    sellerUserId: string,
    lock: { failedCount: number; lockCount: number; lockedUntilMs: number | null },
    nowMs: number,
  ): Promise<void> {
    const next = registerTotpFailure(lock, nowMs);
    await this.d.totp.recordFailure(sellerUserId, next.failedCount, next.lockCount, next.lockedUntilMs);
    if (next.lockedUntilMs !== null && next.lockedUntilMs !== lock.lockedUntilMs) {
      await this.d.events.publish({ type: "seller.totp_locked", sellerUserId, lockedUntilMs: next.lockedUntilMs, occurredAtMs: nowMs });
    }
  }
}

export { TOTP, totpStep };
