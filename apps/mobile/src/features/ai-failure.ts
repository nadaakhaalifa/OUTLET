/**
 * Failure vocabulary shared by the Phase 3 AI features (stylist chat, outfit calendar, wardrobe).
 * Ports throw `AiFailure`; screens map `reason` to an AR/EN message (`aiFailure.<reason>`) and never show raw codes.
 */
import { ApiError, NetworkError, TimeoutError } from "../services/api-client";

export const AI_FAILURE_REASONS = [
  "offline",
  /** Daily fair-use quota reached (chat turns or generations). */
  "quota",
  /** Short-window rate limit: try again in a moment. */
  "rateLimited",
  /** Kill switch or provider/storage not configured. */
  "disabled",
  /** The personalization (or cross-border) consent is missing. */
  "consent",
  "notFound",
  /** The item changed elsewhere (If-Match / expected_version). */
  "conflict",
  /** Capacity cap (wardrobe 300 items, pending uploads). */
  "full",
  /** A photo failed the safety scan or could not be used. */
  "rejected",
  /** Nothing to do: for example no wardrobe item fits the occasion. */
  "nothingOwned",
  "failed",
] as const;
export type AiFailureReason = (typeof AI_FAILURE_REASONS)[number];

export class AiFailure extends Error {
  override readonly name = "AiFailure";
  constructor(readonly reason: AiFailureReason, readonly retryAfterSeconds: number | null = null) {
    super(`ai feature failure: ${reason}`);
  }
}

const BY_CODE: Readonly<Record<string, AiFailureReason>> = {
  chat_quota_exceeded: "quota",
  stylist_chat_disabled: "disabled",
  wardrobe_disabled: "disabled",
  wardrobe_vision_disabled: "disabled",
  wardrobe_vision_unconfigured: "disabled",
  wardrobe_storage_unconfigured: "disabled",
  catalog_unavailable: "disabled",
  consent_required: "consent",
  version_conflict: "conflict",
  attributes_edited: "conflict",
  wardrobe_full: "full",
  too_many_pending_uploads: "full",
  upload_rejected: "rejected",
  upload_unavailable: "rejected",
  photo_not_ready: "rejected",
  no_photo: "rejected",
  no_suggestion: "rejected",
  nothing_owned: "nothingOwned",
};

/** Maps any thrown value to an AiFailure. Contract drift and unknown errors become "failed" (kept as cause). */
export function failureOf(e: unknown): AiFailure {
  if (e instanceof AiFailure) return e;
  if (e instanceof NetworkError || e instanceof TimeoutError) return new AiFailure("offline");
  if (e instanceof ApiError) {
    const byCode = e.code === undefined ? undefined : BY_CODE[e.code];
    if (byCode !== undefined) return new AiFailure(byCode, e.retryAfterSeconds);
    if (e.status === 429) return new AiFailure("rateLimited", e.retryAfterSeconds);
    if (e.status === 404) return new AiFailure("notFound");
    if (e.status === 403) return new AiFailure("consent");
    if (e.status === 503) return new AiFailure("disabled", e.retryAfterSeconds);
    if (e.status === 409) return new AiFailure("conflict");
    return new AiFailure("failed");
  }
  const f = new AiFailure("failed");
  (f as { cause?: unknown }).cause = e;
  return f;
}

export async function aiGuard<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    throw failureOf(e);
  }
}

/** Reason for an arbitrary caught value (screens). */
export function reasonOf(e: unknown): AiFailureReason {
  return failureOf(e).reason;
}
