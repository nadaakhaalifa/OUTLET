import type { SessionTokens } from "../api/schemas";
import type { Result } from "../lib/result";

export type SessionFailure = "cancelled" | "unsupported" | "rejected" | "network" | "totp_unavailable";

export interface SessionState {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAtMs: number;
  /** True while the server still wants a second factor (TOTP) before the token is fully privileged. */
  readonly secondFactorRequired: boolean;
}

/**
 * Session handling for passkey (and TOTP fallback) sign-in. The API client only needs `accessToken` and `refresh`.
 * Real implementation: session/api-session.ts. Test double: session/fake.ts.
 */
export interface SessionPort {
  current(): Promise<SessionState | null>;
  signInWithPasskey(): Promise<Result<SessionState, SessionFailure>>;
  verifyTotp(code: string): Promise<Result<SessionState, SessionFailure>>;
  refresh(): Promise<Result<SessionState, SessionFailure>>;
  signOut(): Promise<void>;
}

export function toState(tokens: SessionTokens): SessionState {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessExpiresAtMs: Date.parse(tokens.access_expires_at),
    secondFactorRequired: tokens.second_factor_required === true,
  };
}

/** Where tokens live between requests (httpOnly cookie in the Next adapter, a variable in tests). */
export interface SessionStore {
  read(): Promise<SessionState | null>;
  write(state: SessionState | null): Promise<void>;
}

/** Wraps navigator.credentials; kept behind a port so no browser API is needed in tests. */
export interface CredentialPort {
  /** Returns a serialisable assertion for the challenge, "cancelled" if the user dismissed, or "unsupported". */
  getAssertion(options: { challenge: string; rpId: string }): Promise<Result<unknown, "cancelled" | "unsupported">>;
}
