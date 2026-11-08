import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_REPORT_BYTES, handleCspReport, resetCspRateLimit } from "../src/server/csp-report";

const logs: string[] = [];
let t = 1_000_000;
const deps = { now: () => t, log: (l: string) => { logs.push(l); } };
const post = (body: unknown, contentType = "application/csp-report") => handleCspReport({ method: "POST", contentType, body: typeof body === "string" ? body : JSON.stringify(body) }, deps);
beforeEach(() => { logs.length = 0; resetCspRateLimit(); t += 120_000; });

describe("handleCspReport", () => {
  it("logs directive, blocked origin and document origin only (no paths, queries or PII) and answers 204", () => {
    const r = post({ "csp-report": { "document-uri": "https://shop.test/eg-ar/bag?token=SECRET", "blocked-uri": "https://evil.test/x.js?u=1", "effective-directive": "script-src-elem", "original-policy": "default-src 'self'" } });
    expect(r.status).toBe(204);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual({ event: "csp.violation", directive: "script-src-elem", blocked: "https://evil.test", document: "https://shop.test" });
    expect(logs[0]).not.toContain("SECRET");
  });
  it("understands the Reporting API batch format and caps a batch at 10", () => {
    const item = (n: number) => ({ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "inline", documentURL: `https://shop.test/${String(n)}` } });
    post(Array.from({ length: 12 }, (_, i) => item(i)), "application/reports+json");
    expect(logs).toHaveLength(10);
    expect((JSON.parse(logs[0] ?? "") as { blocked: string }).blocked).toBe("inline");
  });
  it("ignores junk quietly: other methods are 405, bad content types, oversize, invalid JSON and unknown shapes are 204 without a log", () => {
    expect(handleCspReport({ method: "GET", contentType: null, body: "" }, deps).status).toBe(405);
    expect(post({ "csp-report": { "effective-directive": "x" } }, "text/plain").status).toBe(204);
    expect(post("x".repeat(MAX_REPORT_BYTES + 1)).status).toBe(204);
    expect(post("{").status).toBe(204);
    expect(post(["nope", 3]).status).toBe(204);
    expect(post({ "csp-report": { "blocked-uri": "x" } }).status).toBe(204);
    expect(post({ "csp-report": { "effective-directive": "<script>", "blocked-uri": "not a url at all ???" } }).status).toBe(204);
    expect(logs).toEqual([]);
  });
  it("is rate limited per window and recovers in the next one", () => {
    const body = { "csp-report": { "effective-directive": "img-src", "blocked-uri": "data" } };
    for (let i = 0; i < 100; i += 1) expect(post(body).status).toBe(204);
    expect(logs).toHaveLength(60);
    t += 60_001;
    post(body);
    expect(logs).toHaveLength(61);
  });
  it("renders a scheme-only blocked-uri as the scheme and anything odd as 'other'", () => {
    post({ "csp-report": { "effective-directive": "img-src", "blocked-uri": "data:image/png;base64,AAAA", "document-uri": "weird value with spaces" } });
    expect(JSON.parse(logs[0] ?? "")).toMatchObject({ blocked: "data:", document: "other" });
    vi.restoreAllMocks();
  });
});
