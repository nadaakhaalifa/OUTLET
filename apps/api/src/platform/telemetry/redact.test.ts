import { describe, expect, it } from "vitest";
import { sanitizeAttributes } from "./attributes";
import { formatLogLine } from "./logger";
import { fingerprintSql, hashId, redactRecord, redactString } from "./redact";

describe("redaction", () => {
  it("redacts sensitive keys and value patterns, deeply", () => {
    const out = redactRecord({
      phone: "+201001234567",
      note: "call +20 100 123 4567 or a@b.com with Bearer abc.def.ghi",
      nested: { authorization: "Bearer x", ok: 3, list: [{ iban: "EG12" }, "mail me x@y.io"] },
      job: "outbox",
    });
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/1234567|a@b\.com|abc\.def|EG12|x@y\.io|Bearer x/);
    expect(out["job"]).toBe("outbox");
    expect((out["nested"] as { ok: number }).ok).toBe(3);
  });
  it("redacts jwt-shaped strings", () => {
    expect(redactString("t=eyJhbGciOi.eyJzdWIiOi.sig123")).not.toContain("eyJ");
  });
  it("log lines are JSON with redaction", () => {
    const line = JSON.parse(formatLogLine("info", "e", { email: "a@b.com", n: 1 })) as Record<string, unknown>;
    expect(line["email"]).toBe("[REDACTED]");
    expect(line["n"]).toBe(1);
  });
  it("hashes ids stably without revealing them", () => {
    expect(hashId("user-1")).toBe(hashId("user-1"));
    expect(hashId("user-1")).not.toContain("user-1");
    expect(hashId("user-1")).toHaveLength(16);
  });
  it("fingerprints SQL without literals or params", () => {
    const a = fingerprintSql("SELECT * FROM users WHERE phone = '+2010' AND id = $1 AND n IN (1, 2, 3)");
    expect(a.text).not.toMatch(/2010|\$1|\b3\b/);
    expect(a.hash).toBe(fingerprintSql("SELECT * FROM users WHERE phone = '+9999' AND id = $7 AND n IN (4, 5)").hash);
  });
});

describe("attribute allow-list", () => {
  it("drops anything not listed, objects and non-finite numbers", () => {
    const out = sanitizeAttributes({
      "http.route": "/v1/x/:id",
      "http.request.body": "secret",
      "user.email": "a@b.com",
      "http.response.status_code": 200,
      "db.rows": Number.NaN,
      "outlet.provider": { a: 1 },
    });
    expect(out).toEqual({ "http.route": "/v1/x/:id", "http.response.status_code": 200 });
  });
});
