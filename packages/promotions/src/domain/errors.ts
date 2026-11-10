export type PromotionErrorCode =
  | "INVALID_RULES"
  | "INVALID_PROMOTION"
  | "STACKING_VIOLATION"
  | "TOO_MANY_CANDIDATES"
  | "INVALID_TRANSITION"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "NOT_EDITABLE"
  | "CODE_INVALID"
  | "CAP_EXCEEDED"
  | "ABUSE_BLOCKED"
  | "REINSTATE_NOT_ALLOWED"
  | "DISABLED"
  | "NO_AUDIT";

export class PromotionError extends Error {
  readonly code: PromotionErrorCode;
  constructor(code: PromotionErrorCode, message: string) {
    super(message);
    this.name = "PromotionError";
    this.code = code;
  }
}
