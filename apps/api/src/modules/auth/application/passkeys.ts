import {
  MS,
  checkSignCount,
  sha256Hex,
  revokeFamily,
  revokeSession,
  type AttestationVerifier,
  type Csprng,
  type PasskeyVerifier,
} from "@outlet/auth-core";
import type {
  AdminGrantReader,
  AuthEventPublisher,
  PasskeyChallengeStore,
  PasskeyCredentialRepository,
  SessionRepository,
  User,
  UserDirectory,
} from "../domain/ports";
import type { AgeGate } from "./age-gate";
import { attestDevice, type Attestation, type Clock } from "./common";
import type { IssuedSession, SessionIssuer } from "./session-issuer";

export const PASSKEY_CHALLENGE_TTL_MS = 5 * MS.minute;

export interface PasskeyDeps {
  readonly verifier: PasskeyVerifier;
  readonly attestation: AttestationVerifier;
  readonly challenges: PasskeyChallengeStore;
  readonly credentials: PasskeyCredentialRepository;
  readonly users: UserDirectory;
  readonly sessions: SessionRepository;
  readonly issuer: SessionIssuer;
  readonly ageGate: AgeGate;
  /** Web sign-in gate: only users with an unexpired standing admin grant may open a web session. */
  readonly adminGrants: AdminGrantReader;
  readonly events: AuthEventPublisher;
  readonly clock: Clock;
  readonly rng: Csprng;
  readonly newId: () => string;
  readonly rpId: string;
}

export interface ChallengeOptions {
  readonly challengeId: string;
  /** base64url, 32 random bytes. */
  readonly challenge: string;
  readonly rpId: string;
  readonly expiresAtMs: number;
}

export type RegisterResult =
  | { readonly kind: "registered" }
  | { readonly kind: "challenge_invalid" }
  /** The challenge exists but was issued to someone else: indistinguishable from unknown (404). */
  | { readonly kind: "not_found" }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "already_registered" };

export type AssertResult =
  | ({ readonly kind: "ok"; readonly user: User; readonly installToken?: string } & IssuedSession)
  /** Platform web for a user without an admin grant (shopper web is Phase 3). */
  | { readonly kind: "web_sign_in_not_allowed" }
  | { readonly kind: "attestation_failed" }
  | { readonly kind: "age_gate_required" }
  | { readonly kind: "age_blocked"; readonly blockedUntilMs: number }
  /** Unknown challenge, unknown credential, bad signature and clone suspicion look the same to the caller. */
  | { readonly kind: "rejected"; readonly reason: string };

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export class PasskeyService {
  constructor(private readonly deps: PasskeyDeps) {}

  async issueChallenge(purpose: "register" | "assert", userId: string | null): Promise<ChallengeOptions> {
    const d = this.deps;
    const nowMs = d.clock.nowMs();
    const record = {
      id: d.newId(),
      challenge: base64url(d.rng.randomBytes(32)),
      purpose,
      userId,
      expiresAtMs: nowMs + PASSKEY_CHALLENGE_TTL_MS,
    } as const;
    await d.challenges.put(record);
    return { challengeId: record.id, challenge: record.challenge, rpId: d.rpId, expiresAtMs: record.expiresAtMs };
  }

  async register(input: { userId: string; challengeId: string; response: unknown }): Promise<RegisterResult> {
    const d = this.deps;
    const nowMs = d.clock.nowMs();
    const peeked = await d.challenges.peek(input.challengeId, nowMs);
    if (peeked === null) return { kind: "challenge_invalid" };
    if (peeked.userId !== input.userId) return { kind: "not_found" };
    if (peeked.purpose !== "register") return { kind: "challenge_invalid" };

    // Single use: consumed whether or not verification succeeds.
    const challenge = await d.challenges.take(input.challengeId, nowMs);
    if (challenge === null) return { kind: "challenge_invalid" };

    let result;
    try {
      result = await d.verifier.verifyRegistration({ challenge: challenge.challenge, response: input.response });
    } catch {
      return { kind: "rejected", reason: "invalid_response" };
    }
    if (!result.ok) return { kind: "rejected", reason: result.reason };
    const inserted = await d.credentials.insert({
      userId: input.userId,
      credentialId: result.value.credentialId,
      publicKey: result.value.publicKey,
      signCount: result.value.signCount,
      backupEligible: result.value.backupEligible ?? false,
      backedUp: result.value.backedUp ?? false,
      status: "active",
      createdAtMs: nowMs,
    });
    return inserted ? { kind: "registered" } : { kind: "already_registered" };
  }

  async assert(input: {
    challengeId: string;
    credentialId: string;
    response: unknown;
    /** Ignored for platform web: the server mints the install id. */
    installId: string | null;
    platform: "ios" | "android" | "web";
    attestation: Attestation | null;
  }): Promise<AssertResult> {
    const d = this.deps;
    const isWeb = input.platform === "web";
    // Browsers have no App Attest or Play Integrity: the WebAuthn origin check and the admin grant
    // below are the binding for web (ADR-0048 decision 6). Mobile keeps attestation and the age gate.
    if (!isWeb) {
      const deviceKey = await attestDevice(d.attestation, input.attestation);
      if (deviceKey === null) return { kind: "attestation_failed" };
      const gate = await d.ageGate.status(deviceKey);
      if (gate.kind === "required") return { kind: "age_gate_required" };
      if (gate.kind === "blocked") return { kind: "age_blocked", blockedUntilMs: gate.blockedUntilMs };
    }

    const nowMs = d.clock.nowMs();
    const challenge = await d.challenges.take(input.challengeId, nowMs);
    if (challenge === null || challenge.purpose !== "assert") return { kind: "rejected", reason: "invalid_challenge" };

    const stored = await d.credentials.find(input.credentialId);
    if (stored === null || stored.status !== "active") return { kind: "rejected", reason: "unknown_credential" };
    // A challenge bound to an account (the recycled-number step-up) is satisfied only by that account's credential.
    if (challenge.userId !== null && challenge.userId !== stored.userId) return { kind: "rejected", reason: "unknown_credential" };

    let verified;
    try {
      verified = await d.verifier.verifyAssertion({
        challenge: challenge.challenge,
        response: input.response,
        credential: {
          credentialId: stored.credentialId,
          publicKey: stored.publicKey,
          signCount: stored.signCount,
          backupEligible: stored.backupEligible ?? false,
          backedUp: stored.backedUp ?? false,
        },
      });
    } catch {
      return { kind: "rejected", reason: "invalid_response" };
    }
    if (!verified.ok) {
      if (verified.reason === "sign_count_regression") await this.suspectClone(stored.userId, stored.credentialId, nowMs);
      return { kind: "rejected", reason: verified.reason };
    }
    // A user handle, when the authenticator returns one, must name the owner of the stored credential.
    if (
      verified.value.credentialId !== stored.credentialId ||
      (verified.value.userHandle !== null && verified.value.userHandle !== stored.userId)
    ) {
      return { kind: "rejected", reason: "unknown_credential" };
    }
    // BE is immutable for a credential (WebAuthn L3 6.1.3): a flip means a different authenticator.
    if (verified.value.backupEligible !== undefined && verified.value.backupEligible !== (stored.backupEligible ?? false)) {
      return { kind: "rejected", reason: "invalid_response" };
    }

    // Defence in depth: the counter rule is enforced here regardless of the verifier adapter.
    const counter = checkSignCount(stored.signCount, verified.value.newSignCount);
    if (!counter.ok) {
      await this.suspectClone(stored.userId, stored.credentialId, nowMs);
      return { kind: "rejected", reason: counter.reason };
    }
    await d.credentials.update({
      ...stored,
      signCount: verified.value.newSignCount,
      backedUp: verified.value.backedUp ?? stored.backedUp ?? false,
    });

    const user = await d.users.findById(stored.userId);
    if (user === null) return { kind: "rejected", reason: "unknown_credential" };
    if (isWeb) return this.openWebSession(user, nowMs);
    if (input.installId === null) return { kind: "rejected", reason: "missing_install_id" };
    const issued = await d.issuer.open({
      user,
      installId: input.installId,
      platform: input.platform as "ios" | "android",
      amr: ["passkey", "attestation"],
      uv: true,
    });
    return { kind: "ok", user, ...issued };
  }

  /**
   * Web branch (spec track 1, "Session binding"). Reached only after the assertion verified with user
   * verification. The credential's user must hold an admin grant (else 403, nothing is issued). The
   * install id and the install token are minted here, the token's hash is stored, and any earlier
   * web device of this user is revoked, so the token rotates at every login.
   */
  private async openWebSession(user: User, nowMs: number): Promise<AssertResult> {
    const d = this.deps;
    if (!(await d.adminGrants.hasStandingAdminGrant(user.id, nowMs))) return { kind: "web_sign_in_not_allowed" };
    await this.revokeWebDevices(user.id, nowMs);
    const installToken = base64url(d.rng.randomBytes(32));
    const issued = await d.issuer.open({
      user,
      installId: d.newId(),
      platform: "web",
      amr: ["passkey", "webauthn"],
      audience: "admin_api",
      uv: true,
      installSecretHash: sha256Hex(installToken),
    });
    return { kind: "ok", user, installToken, ...issued };
  }

  private async revokeWebDevices(userId: string, nowMs: number): Promise<void> {
    const d = this.deps;
    for (const s of await d.sessions.listByUser(userId)) {
      if (s.platform !== "web") continue;
      if (s.session.revokedAtMs === null) {
        await d.sessions.save({
          ...s,
          session: revokeSession(s.session, nowMs),
          family: revokeFamily(s.family, nowMs, "admin"),
          installSecretHash: null,
        });
        await d.events.publish({
          type: "session.revoked",
          sessionId: s.session.id,
          userId,
          familyId: s.family.familyId,
          reason: "web_login_rotated",
          notifyUser: false,
          occurredAtMs: nowMs,
        });
      } else if (s.installSecretHash !== null && s.installSecretHash !== undefined) {
        await d.sessions.save({ ...s, installSecretHash: null });
      }
    }
  }

  /** A rolled-back counter means the private key may have been cloned: disable it, end every session. */
  private async suspectClone(userId: string, credentialId: string, nowMs: number): Promise<void> {
    const d = this.deps;
    const stored = await d.credentials.find(credentialId);
    if (stored !== null) await d.credentials.update({ ...stored, status: "suspected_clone" });
    for (const s of await d.sessions.listByUser(userId)) {
      if (s.session.revokedAtMs !== null) continue;
      await d.sessions.save({
        ...s,
        session: revokeSession(s.session, nowMs),
        family: revokeFamily(s.family, nowMs, "admin"),
      });
      await d.events.publish({
        type: "session.revoked",
        sessionId: s.session.id,
        userId,
        familyId: s.family.familyId,
        reason: "clone_suspected",
        notifyUser: true,
        occurredAtMs: nowMs,
      });
    }
  }
}

