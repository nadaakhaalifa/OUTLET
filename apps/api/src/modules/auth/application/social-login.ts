import {
  sha256Hex,
  type AppleIdentityVerifier,
  type AttestationVerifier,
  type GoogleIdentityVerifier,
  type IdentityVerification,
  MS,
} from "@outlet/auth-core";
import type { NonceStore, User, UserDirectory, UserLanguage } from "../domain/ports";
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
}

export type SocialLoginFailure = Extract<IdentityVerification, { ok: false }>["reason"] | "nonce_reused";

export type SocialLoginResult =
  | ({ readonly kind: "ok"; readonly user: User } & IssuedSession)
  | { readonly kind: "attestation_failed" }
  | { readonly kind: "age_gate_required" }
  | { readonly kind: "age_blocked"; readonly blockedUntilMs: number }
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
    const user = await d.users.findOrCreateByIdentity({
      provider: input.provider,
      subject: identity.subject,
      email: identity.emailVerified ? identity.email : null,
      language: input.language,
      newId: d.newId(),
      nowMs,
    });
    const issued = await d.issuer.open({
      user,
      installId: input.installId,
      platform: input.platform,
      amr: [input.provider, "attestation"],
    });
    return { kind: "ok", user, ...issued };
  }
}
