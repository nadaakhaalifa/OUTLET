export type MediaErrorCode =
  | "too_large"
  | "type_not_allowed"
  | "mime_mismatch"
  | "invalid_image"
  | "variant_too_large"
  | "ttl_invalid"
  | "not_found"
  | "forbidden"
  | "reason_required"
  | "av_unavailable"
  | "not_ready";

export class MediaError extends Error {
  constructor(
    readonly code: MediaErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "MediaError";
  }
}
