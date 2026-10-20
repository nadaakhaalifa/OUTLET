import type { CivilDate, ConsentMethod, ConsentPurpose, DeletionSnapshot } from "../workspace";
import type { AuthTokens } from "../platform/secure-storage";

export type ApiErrorCode =
  | "network"
  | "unavailable"
  | "rate_limited"
  | "invalid_code"
  | "code_expired"
  | "country_not_supported"
  | "age_not_eligible"
  | "deletion_blocked"
  | "unauthenticated"
  /** Sign-in-only verify: the number has no account (nothing was created). */
  | "no_account"
  /** Sign-in-only verify answered 404 for another reason (feature blocked). */
  | "sign_in_unavailable"
  /** Sign-in-only verify: a recycled number on a new install needs a passkey before any token exists (VR-GUEST-06). */
  | "step_up_required";

/** Account-bound passkey challenge from a 403 step_up_required. No user id or factor hint. */
export interface StepUpChallenge {
  readonly challengeId: string;
  readonly challenge: string;
  readonly rpId: string;
  readonly expiresAtMs: number;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: ApiErrorCode; readonly retryAfterSeconds?: number; readonly stepUp?: StepUpChallenge } };

export interface OtpRequested {
  readonly sendsSoFar: number;
}

export interface VerifiedLogin {
  readonly tokens: AuthTokens;
  readonly isNewAccount: boolean;
}

export interface ConsentChange {
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly version: number;
  readonly method: ConsentMethod;
  readonly at: string;
}

export interface ExportRequested {
  readonly requestId: string;
  readonly dueAt: string;
}

export interface DeletionRequested {
  readonly coolingEndsAt: string;
  readonly forfeitedStoreCreditMinor: bigint;
}

export interface ApiSession {
  readonly id: string;
  readonly deviceLabel: string;
  readonly lastUsedAt: string;
  readonly current: boolean;
}

/**
 * Port to the Outlet API (docs/api/openapi.yaml). Every call is explicit about failure through
 * ApiResult; implementations never throw for expected failures. A real HTTP adapter does not exist
 * yet: no backend is deployed (owner decision 2026-10-10).
 */
export interface OutletApi {
  requestOtp(input: { phoneE164: string; locale: "ar" | "en"; idempotencyKey: string }): Promise<ApiResult<OtpRequested>>;
  /** `mode: "existing_only"` (G-9) signs in an existing account and never creates one. */
  verifyOtp(input: { phoneE164: string; code: string; mode?: "existing_only" }): Promise<ApiResult<VerifiedLogin>>;
  /** Completes a step-up (or a passkey sign-in) with the platform assertion. Never creates an account. */
  assertPasskey(input: { challengeId: string; credential: Readonly<Record<string, unknown>> }): Promise<ApiResult<VerifiedLogin>>;
  /** Sent once, only after the local age gate accepted. The server stores the DOB; the device does not. */
  submitAge(input: { dob: CivilDate; attestedAtLeast18: true }): Promise<ApiResult<void>>;
  recordConsent(change: ConsentChange): Promise<ApiResult<void>>;
  getDeletionSnapshot(): Promise<ApiResult<DeletionSnapshot>>;
  requestDataExport(input: { idempotencyKey: string }): Promise<ApiResult<ExportRequested>>;
  requestAccountDeletion(input: { acknowledgedForfeiture: boolean; idempotencyKey: string }): Promise<ApiResult<DeletionRequested>>;
  cancelAccountDeletion(): Promise<ApiResult<void>>;
  listSessions(): Promise<ApiResult<readonly ApiSession[]>>;
}
