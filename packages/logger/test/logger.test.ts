import { describe, expect, it } from "vitest";
import { createLogger, redact, redactString } from "../src/index.js";

function capture(level?: "debug" | "info" | "warn" | "error") {
  const lines: string[] = [];
  const log = createLogger({ ...(level ? { level } : {}), write: (l) => lines.push(l), now: () => new Date(0) });
  return { lines, log };
}

describe("redact by key", () => {
  it("masks sensitive keys at any depth, AR and EN values", () => {
    const out = JSON.stringify(redact({
      user: { email: "a@b.com", dob: "1990-01-01", address: "١٢ شارع التحرير", iban: "EG12345", national_id: "29001011234567" },
      list: [{ password: "hunter2" }, { Authorization: "Bearer xyz" }, { cookie: "s=1" }, { measurements: { waist: 70 } }],
      session_token: "abc",
    }));
    for (const leak of ["a@b.com", "1990", "التحرير", "EG12345", "2900101", "hunter2", "xyz", "s=1", "70", "abc"]) {
      expect(out).not.toContain(leak);
    }
  });
  it("keeps last 2 digits of phone fields", () => {
    expect(redact({ phone: "+201001234567" })).toEqual({ phone: "***67" });
  });
});

describe("redact by pattern", () => {
  it("masks E.164, email, card and JWT inside free text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig_nature";
    const s = redactString(`call +201001234567 mail x@y.org card 4111 1111 1111 1111 jwt ${jwt}`);
    expect(s).not.toMatch(/2010012345|x@y\.org|4111|eyJ/);
    expect(s).toContain("***67");
  });
});

describe("robustness", () => {
  it("handles circular references and never throws", () => {
    const a: Record<string, unknown> = { name: "n" };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
    expect(JSON.stringify(redact(a))).toContain("[Circular]");
  });
  it("handles bigint, throwing getters and deep nesting", () => {
    const o = { n: 5n, get bad(): string { throw new Error("x"); } };
    expect(() => redact(o)).not.toThrow();
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 50; i++) { const n = {}; deep.c = n; deep = n; }
    expect(JSON.stringify(redact(root))).toContain("[MaxDepth]");
  });
});

describe("logger", () => {
  it("emits JSON with level, context and redacted fields", () => {
    const { lines, log } = capture();
    log.child({ requestId: "r1", marketId: "EG" }).info("hello a@b.com", { phone: "+201001234567" });
    const rec = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(rec).toMatchObject({ level: "info", requestId: "r1", marketId: "EG", phone: "***67" });
    expect(lines[0]).not.toMatch(/a@b\.com|2010012345/);
  });
  it("respects levels and survives circular fields", () => {
    const { lines, log } = capture("warn");
    log.info("no");
    const c: Record<string, unknown> = {};
    c.c = c;
    log.error("yes", c);
    expect(lines).toHaveLength(1);
  });
});

describe("logger extras", () => {
  it("covers all levels, default sink and unserialisable records", () => {
    const { lines, log } = capture("debug");
    log.debug("d");
    log.warn("w");
    log.error("e", { err: new Error("boom a@b.com"), when: new Date(0), bad: new Date(NaN), fn: () => 1, big: 1n });
    expect(lines).toHaveLength(3);
    expect(lines[2]).not.toContain("a@b.com");
    const w = process.stdout.write.bind(process.stdout);
    const chunks: string[] = [];
    process.stdout.write = ((s: string) => { chunks.push(s); return true; });
    try { createLogger().info("x"); } finally { process.stdout.write = w; }
    expect(chunks.join("")).toContain('"msg":"x"');
  });
  it("redacts null-valued and non-string sensitive fields without throwing", () => {
    expect(redact({ email: null, phone: 12345 })).toEqual({ email: null, phone: "[REDACTED]" });
    expect(redact({ mobile: "٠١٠٠١٢٣٤٥٦٧" })).toEqual({ mobile: "***67" });
  });
});
