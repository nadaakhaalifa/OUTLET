// Sink for CSP violation reports (report-uri / report-to). Logs a small allow-listed, PII-free summary and answers 204.
export const MAX_REPORT_BYTES = 8 * 1024;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;

export interface CspReportInput {
  readonly method: string;
  readonly contentType: string | null;
  readonly body: string;
}
export interface CspReportDeps {
  readonly now: () => number;
  readonly log: (line: string) => void;
}

const bucket = { start: 0, count: 0 };
/** Process-wide fixed window: a flood of reports cannot turn the log into a cost or a DoS vector. */
function allow(now: number): boolean {
  if (now - bucket.start >= WINDOW_MS) { bucket.start = now; bucket.count = 0; }
  bucket.count += 1;
  return bucket.count <= MAX_PER_WINDOW;
}
export const resetCspRateLimit = (): void => { bucket.start = 0; bucket.count = 0; };

/** Origin or scheme only: report URLs can carry tokens or identifiers in paths and queries. */
function origin(v: unknown): string {
  if (typeof v !== "string" || v === "") return "";
  try {
    const u = new URL(v);
    return u.origin === "null" ? u.protocol : u.origin;
  } catch {
    return v.length <= 16 && /^[a-z-]+$/.test(v) ? v : "other";
  }
}
const word = (v: unknown): string => (typeof v === "string" && /^[A-Za-z0-9 '_-]{1,200}$/.test(v) ? v : "");

function summarize(raw: unknown): Record<string, string> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const r = (typeof o["csp-report"] === "object" && o["csp-report"] !== null ? o["csp-report"] : typeof o.body === "object" && o.body !== null ? o.body : o) as Record<string, unknown>;
  const directive = word(r["effective-directive"] ?? r.effectiveDirective ?? r["violated-directive"]);
  if (directive === "") return null;
  return { directive, blocked: origin(r["blocked-uri"] ?? r.blockedURL), document: origin(r["document-uri"] ?? r.documentURL) };
}

export function handleCspReport(req: CspReportInput, deps: CspReportDeps): { status: number } {
  if (req.method !== "POST") return { status: 405 };
  if (!allow(deps.now())) return { status: 204 };
  if (req.body.length > MAX_REPORT_BYTES) return { status: 204 };
  const ct = (req.contentType ?? "").toLowerCase();
  if (!ct.startsWith("application/csp-report") && !ct.startsWith("application/reports+json") && !ct.startsWith("application/json")) return { status: 204 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body) as unknown;
  } catch {
    return { status: 204 };
  }
  for (const item of Array.isArray(parsed) ? parsed.slice(0, 10) : [parsed]) {
    const s = summarize(item);
    if (s !== null) deps.log(JSON.stringify({ event: "csp.violation", ...s }));
  }
  return { status: 204 };
}
