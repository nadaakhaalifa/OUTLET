export type AdminAccessErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "SELF_GRANT"
  | "SELF_APPROVAL"
  | "ALREADY_DECIDED"
  | "INVALID_TRANSITION"
  | "APPROVAL_NOT_PENDING"
  | "APPROVAL_NOT_APPROVED"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_TAMPERED"
  | "DUAL_APPROVAL_REQUIRED"
  | "ELEVATION_NOT_PENDING"
  | "ELEVATION_EXPIRED"
  | "ALREADY_REVOKED"
  | "REASON_CODE_REQUIRED";

/** Typed error: callers switch on `code`; the message never contains PII. */
export class AdminAccessError extends Error {
  constructor(readonly code: AdminAccessErrorCode, message?: string) {
    super(message ?? code);
    this.name = "AdminAccessError";
  }
}
