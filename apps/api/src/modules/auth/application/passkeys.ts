import {
  MS,
  checkSignCount,
  revokeFamily,
  revokeSession,
  type AttestationVerifier,
  type Csprng,
  type PasskeyVerifier,
} from "@outlet/auth-core";
import type {
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
  | ({ readonly kind: "ok"; readonly user: User } & IssuedSession)
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
      status: "active",
      createdAtMs: nowMs,
    });
    return inserted ? { kind: "registered" } : { kind: "already_registered" };
  }

  async assert(input: {
    challengeId: string;
    credentialId: string;
    response: unknown;
    installId: string;
    platform: "ios" | "android";
    attestation: Attestation | null;
  }): Promise<AssertResult> {
    const d = this.deps;
    const deviceKey = await attestDevice(d.attestation, input.attestation);
    if (deviceKey === null) return { kind: "attestation_failed" };
    const gate = await d.ageGate.status(deviceKey);
    if (gate.kind === "required") return { kind: "age_gate_required" };
    if (gate.kind === "blocked") return { kind: "age_blocked", blockedUntilMs: gate.blockedUntilMs };

    const nowMs = d.clock.nowMs();
    const challenge = await d.challenges.take(input.challengeId, nowMs);
    if (challenge === null || challenge.purpose !== "assert") return { kind: "rejected", reason: "invalid_challenge" };

    const stored = await d.credentials.find(input.credentialId);
    if (stored === null || stored.status !== "active") return { kind: "rejected", reason: "unknown_credential" };

    let verified;
    try {
      verified = await d.verifier.verifyAssertion({
        challenge: challenge.challenge,
        response: input.response,
        credential: { credentialId: stored.credentialId, publicKey: stored.publicKey, signCount: stored.signCount },
      });
    } catch {
      return { kind: "rejected", reason: "invalid_response" };
    }
    if (!verified.ok) {
      if (verified.reason === "sign_count_regression") await this.suspectClone(stored.userId, stored.credentialId, nowMs);
      return { kind: "rejected", reason: verified.reason };
    }
    if (verified.value.credentialId !== stored.credentialId || verified.value.userHandle !== stored.userId) {
      return { kind: "rejected", reason: "unknown_credential" };
    }

    // Defence in depth: the counter rule is enforced here regardless of the verifier adapter.
    const counter = checkSignCount(stored.signCount, verified.value.newSignCount);
    if (!counter.ok) {
      await this.suspectClone(stored.userId, stored.credentialId, nowMs);
      return { kind: "rejected", reason: counter.reason };
    }
    await d.credentials.update({ ...stored, signCount: verified.value.newSignCount });

    const user = await d.users.findById(stored.userId);
    if (user === null) return { kind: "rejected", reason: "unknown_credential" };
    const issued = await d.issuer.open({
      user,
      installId: input.installId,
      platform: input.platform,
      amr: ["passkey", "attestation"],
    });
    return { kind: "ok", user, ...issued };
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

