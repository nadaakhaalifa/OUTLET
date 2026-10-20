import type { ProductMediaSummary, MediaModel } from "../api/schemas-phase3";
import { MEDIA_MODELS } from "../api/schemas-phase3";
import type { ApiError } from "../api/client";
import type { Locale, MessageKey } from "../i18n";
import { formatDateTime } from "../lib/format";

const KNOWN = new Set([
  "no_subject_detected", "subject_too_small", "subject_small", "subject_fills_frame", "subject_cut_by_frame", "subject_touches_border",
  "multiple_components", "mask_holes", "mask_small_holes", "soft_edges", "slightly_soft_edges", "white_on_white_risk", "low_contrast_backdrop",
]);
const READY_SCORE = 70;
export const MAX_RUNS = 5;

export interface MediaRowVM {
  readonly id: string;
  readonly statusKey: MessageKey;
  readonly status: ProductMediaSummary["status"];
  readonly decisionKey: MessageKey;
  /** True once the photo is the image of a product. Shown as "Attached to product". */
  readonly attached: boolean;
  readonly attachedProductId: string | null;
  readonly score: number | null;
  readonly scoreGood: boolean;
  /** Plain-language reason keys; unknown server codes collapse to one generic line (no raw codes shown). */
  readonly reasonKeys: readonly MessageKey[];
  readonly modelKey: MessageKey | null;
  readonly canDecide: boolean;
  readonly canRerun: boolean;
  /** Models offered for "Try another model": the documented allow-list minus the current one. */
  readonly otherModels: readonly MediaModel[];
  readonly hasCutout: boolean;
  readonly updatedAt: string;
}

export function mediaRows(items: readonly ProductMediaSummary[], locale: Locale): readonly MediaRowVM[] {
  return items.map((j) => {
    const settled = j.status === "READY" || j.status === "NEEDS_REVIEW";
    const current = j.model_id ?? j.requested_model;
    return {
      id: j.id,
      status: j.status,
      statusKey: `media.status.${j.status}` as MessageKey,
      decisionKey: `media.decision.${j.decision}` as MessageKey,
      attached: (j.attached_product_id !== null && j.attached_product_id !== undefined),
      attachedProductId: j.attached_product_id ?? null,
      score: j.quality_score,
      scoreGood: j.quality_score !== null && j.quality_score >= READY_SCORE,
      reasonKeys: j.quality_reasons.map((r) => (KNOWN.has(r) ? `media.reason.${r}` : "media.reason.other") as MessageKey),
      modelKey: current !== null && (MEDIA_MODELS as readonly string[]).includes(current) ? (`media.model.${current}` as MessageKey) : null,
      canDecide: settled && j.decision === "none",
      canRerun: j.attempts < MAX_RUNS && (settled || j.status === "FAILED"),
      otherModels: MEDIA_MODELS.filter((m) => m !== current),
      hasCutout: settled,
      updatedAt: formatDateTime(j.updated_at, locale),
    };
  });
}

export type MediaFile = "original" | "png" | "white_jpg";
export const isMediaFile = (v: string): v is MediaFile => v === "original" || v === "png" || v === "white_jpg";
/** Only these image types are ever relayed to the browser. */
export const RELAYED_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Plain-language outcome for the documented failure modes (503 disabled / not configured, 429 quota). */
export function mediaErrorKey(e: ApiError): MessageKey {
  if (e.status === 503) return "media.err.unavailable";
  if (e.status === 429) return "media.err.quota";
  if (e.code === "attempts_exceeded") return "media.err.attempts";
  if (e.code === "consent_required") return "media.err.consent";
  switch (e.kind) {
    case "forbidden": return "state.forbidden";
    case "not_found": return "state.notFound";
    case "unauthorized": return "state.sessionExpired";
    case "rate_limited": return "state.rateLimited";
    case "conflict": return "media.err.changed";
    case "offline": return "state.offline";
    default: return "state.error";
  }
}

