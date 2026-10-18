import {
  sha256Hex,
  type AppleIdentityVerifier,
  type AttestationVerifier,
  type GoogleIdentityVerifier,
  type IdentityVerification,
  MS,
} from "@outlet/auth-core";
import { AccountUnavailableError, type NonceStore, type User, type UserDirectory, type UserLanguage } from "../domain/ports";
import type { AgeGate } from "./age-gate";
import { attestDevice, type Attestation, type Clock } from "./common";
import type { IssuedSession, SessionIssuer } from "./session-issuer";

/** A nonce stays consumed for longer than any provider ID token lives. */
const NONCE_RETENTION_MS = 2 * MS.hour;

export interface SocialLoginDeps {
  readonly attestation: AttestationVerifier;
  readonly apple: AppleIdentityVerifier;
  readonly google: GoogleIdentityVerifier;
  readonly nonces: NonceStore;
  readonly users: UserDirectory;
  readonly issuer: SessionIssuer;
  readonly ageGate: AgeGate;
  readonly clock: Clock;
  readonly newId: () => string;
}

export interface SocialLoginInput {
  readonly provider: "apple" | "google";
  readonly idToken: string;
  readonly nonce: string;
  readonly installId: string;
  readonly platform: "ios" | "android";
  readonly language: UserLanguage;
  readonly attestation: Attestation | null;
  /**
   * `create` (default, the checkout sign-up): an unknown identity gets an account. `existing_only` (quiet sign-in,
   * ADR-0055 G-9): an unknown or suspended identity answers `no_account` and NOTHING is created.
   */
  readonly mode?: "create" | "existing_only";
}

export type SocialLoginFailure = Extract<IdentityVerification, { ok: false }>["reason"] | "nonce_reused";

export type SocialLoginResult =
  | ({ readonly kind: "ok"; readonly user: User } & IssuedSession)
  | { readonly kind: "attestation_failed" }
  | { readonly kind: "age_gate_required" }
  | { readonly kind: "age_blocked"; readonly blockedUntilMs: number }
  /** `existing_only` and no active account for this identity. Reached only after the token verified (and the nonce is consumed). */
  | { readonly kind: "no_account" }
  /** Create mode on an identity whose account is suspended: nothing created, no session. */
  | { readonly kind: "account_unavailable" }
  | { readonly kind: "rejected"; readonly reason: SocialLoginFailure };

export class SocialLogin {
  constructor(private readonly deps: SocialLoginDeps) {}

  async execute(input: SocialLoginInput): Promise<SocialLoginResult> {
    const d = this.deps;
    const deviceKey = await attestDevice(d.attestation, input.attestation);
    if (deviceKey === null) return { kind: "attestation_failed" };
    const gate = await d.ageGate.status(deviceKey);
    if (gate.kind === "required") return { kind: "age_gate_required" };
    if (gate.kind === "blocked") return { kind: "age_blocked", blockedUntilMs: gate.blockedUntilMs };

    let verdict: IdentityVerification;
    try {
      verdict =
        input.provider === "apple"
          ? await d.apple.verify({ identityToken: input.idToken, expectedNonce: input.nonce })
          : await d.google.verify({ idToken: input.idToken, expectedNonce: input.nonce });
    } catch {
      return { kind: "rejected", reason: "provider_unavailable" };
    }
    if (!verdict.ok) return { kind: "rejected", reason: verdict.reason };

    // Consume only after the signature and claims checked out, so garbage cannot burn nonces.
    const nowMs = d.clock.nowMs();
    const fresh = await d.nonces.consume(
      `${input.provider}:${sha256Hex(input.nonce)}`,
      nowMs + NONCE_RETENTION_MS,
      nowMs,
    );
    if (!fresh) return { kind: "rejected", reason: "nonce_reused" };

    const { identity } = verdict;
    let user: User | null;
    if (input.mode === "existing_only") {
      // Read only. Existence is revealed only to the holder of a valid, fresh provider token for this subject.
      user = await d.users.findByIdentity(input.provider, identity.subject);
      if (user === null) return { kind: "no_account" };
    } else {
      const age = await d.ageGate.passInfo(deviceKey);
      try {
        user = await d.users.findOrCreateByIdentity({
          age,
          provider: input.provider,
          subject: identity.subject,
          email: identity.emailVerified ? identity.email : null,
          language: input.language,
          newId: d.newId(),
          nowMs,
        });
      } catch (error) {
        if (error instanceof AccountUnavailableError) return { kind: "account_unavailable" };
        throw error;
      }
    }
    const issued = await d.issuer.open({
      user,
      installId: input.installId,
      platform: input.platform,
      amr: [input.provider, "attestation"],
    });
    return { kind: "ok", user, ...issued };
  }
}
