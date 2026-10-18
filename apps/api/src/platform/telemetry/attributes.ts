import type { Attributes, AttributeValue } from "@opentelemetry/api";

/**
 * The only span attribute keys that may leave the process. Anything else is dropped, so a new
 * attribute needs a review of this list (no PII, no bodies, no raw ids).
 */
export const ATTRIBUTE_ALLOW_LIST: ReadonlySet<string> = new Set([
  "http.request.method",
  "http.response.status_code",
  "http.route",
  "outlet.request_id",
  "outlet.user_hash",
  "outlet.process",
  "outlet.outcome",
  "outlet.sample.force",
  "outlet.job",
  "outlet.provider",
  "outlet.provider.operation",
  "outlet.outbox.batch",
  "outlet.error.class",
  "db.system",
  "db.application_name",
  "db.statement.fingerprint",
  "db.statement.hash",
  "db.operation.duration_ms",
  "db.rows",
]);

export function sanitizeAttributes(attrs: Readonly<Record<string, unknown>>): Attributes {
  const out: Record<string, AttributeValue> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!ATTRIBUTE_ALLOW_LIST.has(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, 200);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return out;
}
