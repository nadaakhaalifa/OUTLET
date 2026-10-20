import type { SessionTokens } from "../api/schemas";
import type { Result } from "../lib/result";

export type SessionFailure = "cancelled" | "unsupported" | "rejected" | "network";

export interface SessionState {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAtMs: number;
}

/**
 * Admin sessions are PASSKEY ONLY (spec 23 Admin security, T5). There is deliberately no TOTP or OTP method:
 * a port with no weaker path cannot be downgraded to one. A token that the server marks as needing a second
 * factor is refused, not stored.
 */
export interface SessionPort {
  current(): Promise<SessionState | null>;
  signInWithPasskey(): Promise<Result<SessionState, SessionFailure>>;
  refresh(): Promise<Result<SessionState, SessionFailure>>;
  signOut(): Promise<void>;
}

export function toState(tokens: SessionTokens): SessionState {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessExpiresAtMs: Date.parse(tokens.access_expires_at),
  };
}

export interface SessionStore {
  read(): Promise<SessionState | null>;
  write(state: SessionState | null): Promise<void>;
}

export interface CredentialPort {
  getAssertion(options: { challenge: string; rpId: string }): Promise<Result<unknown, "cancelled" | "unsupported">>;
}
