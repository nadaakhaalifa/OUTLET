import type { z } from "zod";

export interface Violation {
  /** RFC 6901 JSON Pointer into the request part that failed. */
  readonly pointer: string;
  readonly code: string;
}

function escapeToken(t: string): string {
  return t.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Field level violations for Problem+JSON. Only the path and the zod issue code are exposed,
 * never the offending value (it may be PII or a secret).
 */
export function toViolations(error: z.ZodError, root = ""): Violation[] {
  return error.issues.map((issue) => ({
    pointer: root + issue.path.map((p) => `/${escapeToken(String(p))}`).join(""),
    code: issue.code,
  }));
}
