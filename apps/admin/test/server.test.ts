// @vitest-environment node
import { describe, expect, it } from "vitest";
import { REASON_CODES as PACKAGE_REASON_CODES } from "@outlet/admin-access";
import { planProxy, REASON_HEADER, passResponse, problemResponse } from "../src/server/bff";
import { readEnv } from "../src/server/env";
import { AdminSessionBody, can, parseProfile, profileFromSession, serializeProfile, visibleSections } from "../src/server/session";
import { REASON_CODES, reasonHeader } from "../src/lib/reason-codes";
import { problemKey } from "../src/lib/problem";
import { fmtDateTime, fmtMoney, hoursUntil } from "../src/lib/fmt";
import { assertionToJson, fromB64u, requestOptionsFromJson, toB64u } from "../src/lib/webauthn";

const ID = "c0de0000-0000-4000-8000-000000000001";
const cookies = (v: string | undefined) => ({ get: (n: string) => (n === "admin_session" && v !== undefined ? { value: v } : undefined) });
const same = new Headers({ "sec-fetch-site": "same-origin", host: "a.test", origin: "http://a.test" });
const base = { method: "GET", segments: ["eg", "kyc-cases"], search: "?status=SUBMITTED", headers: same, cookies: cookies("tok"), body: null, apiUrl: "http://api.test/" } as const;

describe("BFF plan", () => {
  it("forwards a GET with the bearer token and the query", () => {
    const p = planProxy(base);
    expect(p.kind).toBe("forward");
    if (p.kind === "forward") {
      expect(p.url).toBe("http://api.test/v1/eg/admin/kyc-cases?status=SUBMITTED");
      expect(p.init.headers.get("authorization")).toBe("Bearer tok");
    }
  });
  it("rejects unknown markets, unknown paths, wrong methods and cross-origin writes", () => {
    expect(planProxy({ ...base, segments: ["EGYPT", "kyc-cases"] })).toMatchObject({ status: 404 });
    expect(planProxy({ ...base, segments: ["eg", "staff"] })).toMatchObject({ status: 404 });
    expect(planProxy({ ...base, method: "DELETE" })).toMatchObject({ status: 405 });
    expect(planProxy({ ...base, method: "POST", segments: ["eg", "kyc-cases", ID, "decision"], headers: new Headers({ "sec-fetch-site": "cross-site" }) })).toMatchObject({ status: 403 });
  });
  it("answers 401 without a session and 503 without an API", () => {
    expect(planProxy({ ...base, cookies: cookies(undefined) })).toMatchObject({ status: 401 });
    expect(planProxy({ ...base, cookies: cookies("") })).toMatchObject({ status: 401 });
    expect(planProxy({ ...base, apiUrl: undefined })).toMatchObject({ status: 503 });
  });
  it("lets the passkey ceremony through without a session", () => {
    const p = planProxy({ ...base, method: "POST", segments: ["eg", "auth", "passkey", "options"], cookies: cookies(undefined), body: new ArrayBuffer(2) });
    expect(p.kind).toBe("forward");
    if (p.kind === "forward") {
      expect(p.init.headers.get("authorization")).toBeNull();
      expect(p.init.body).toBeDefined();
    }
  });
  it("forwards a valid X-Reason-Code and refuses a malformed one", () => {
    const seg = ["eg", "kyc-cases", ID, "documents", ID, "url"];
    const ok = planProxy({ ...base, segments: seg, headers: new Headers({ "x-reason-code": "support_ticket:T-12" }) });
    expect(ok.kind === "forward" && ok.init.headers.get("x-reason-code")).toBe("support_ticket:T-12");
    expect(planProxy({ ...base, segments: seg, headers: new Headers({ "x-reason-code": "DROP TABLE" }) })).toMatchObject({ status: 422 });
  });
  it("builds problem and pass-through responses without leaking headers", async () => {
    expect((await problemResponse(404, "x").json()) as { code: string }).toMatchObject({ code: "x" });
    const r = await passResponse(new Response("{}", { status: 200, headers: { "content-type": "application/json", "x-session-token": "secret", "set-cookie": "a=b" } }));
    expect(r.headers.get("x-session-token")).toBeNull();
    expect(r.headers.get("set-cookie")).toBeNull();
    expect((await passResponse(new Response(null, { status: 204 }))).status).toBe(204);
  });
  it("reads env", () => {
    expect(readEnv({}).API_URL).toBeUndefined();
    expect(readEnv({ API_URL: "http://x.test", CSP_TRUSTED_TYPES: "on" })).toMatchObject({ CSP_TRUSTED_TYPES: "on" });
    expect(REASON_HEADER.test("dsar")).toBe(true);
  });
});

describe("session and roles", () => {
  const body = AdminSessionBody.parse({ staff_id: ID, market_id: "eg", roles: ["ops", "bogus", "super_admin"], amr: ["hwk"], expires_at: "2099-01-01T00:00:00Z" });
  it("keeps only known roles and flags break-glass for super_admin", () => {
    const p = profileFromSession(body);
    expect(p.roles).toEqual(["ops", "super_admin"]);
    expect(p.breakGlass).toBe(true);
    expect(parseProfile(serializeProfile(p), new Date("2026-11-08"))).toMatchObject({ staffId: ID, breakGlass: true });
  });
  it("rejects missing, malformed and expired cookies", () => {
    const p = serializeProfile(profileFromSession(body));
    expect(parseProfile(undefined, new Date())).toBeNull();
    expect(parseProfile("", new Date())).toBeNull();
    expect(parseProfile("{nope", new Date())).toBeNull();
    expect(parseProfile(p, new Date("2100-01-01"))).toBeNull();
  });
  it("shows sections by role (ADMIN_POLICY), and super_admin counts only in break-glass", () => {
    const mk = (roles: string[], breakGlass = false) => ({ ...profileFromSession({ ...body, roles }), breakGlass });
    expect(visibleSections(mk(["ops"]))).toEqual(["kyc", "price", "attention", "access"]);
    expect(visibleSections(mk(["finance"]))).toEqual(["recon", "attention", "access"]);
    expect(visibleSections(mk(["dpo"]))).toEqual(["dpo", "access"]);
    expect(visibleSections(mk(["security"]))).toEqual(["audit", "access"]);
    expect(visibleSections(mk(["marketing"]))).toEqual(["access"]);
    expect(can(mk(["super_admin"], false), "audit.read")).toBe(false);
    expect(can(mk(["super_admin"], true), "audit.read")).toBe(true);
  });
});

describe("reason codes", () => {
  it("mirror @outlet/admin-access", () => {
    expect([...REASON_CODES]).toEqual([...PACKAGE_REASON_CODES]);
  });
  it("builds the header and demands a reference for other_with_note", () => {
    expect(reasonHeader("dsar", "")).toBe("dsar");
    expect(reasonHeader("dsar", " T-9 ")).toBe("dsar:T-9");
    expect(reasonHeader("other_with_note", "")).toBeNull();
    expect(reasonHeader("dsar", "bad ref!")).toBeNull();
    expect(reasonHeader("nope", "")).toBeNull();
    expect(REASON_HEADER.test(reasonHeader("fraud_review", "A1") ?? "")).toBe(true);
  });
});

describe("helpers", () => {
  it("maps problems to messages", () => {
    expect(problemKey("reason-code-required", 400)).toBe("admin.error.reasonRequired");
    expect(problemKey("zzz", 404)).toBe("admin.error.routeMissing");
    expect(problemKey("zzz", 403)).toBe("admin.error.forbidden");
    expect(problemKey("zzz", 401)).toBe("admin.error.unauthenticated");
    expect(problemKey("zzz", 503)).toBe("admin.error.apiDown");
    expect(problemKey("zzz", 500)).toBe("admin.error.generic");
  });
  it("formats safely", () => {
    expect(fmtDateTime(null, "ar-EG")).toBe("");
    expect(fmtDateTime("garbage", "en-EG")).toBe("garbage");
    expect(fmtDateTime("2026-11-08T10:00:00Z", "en-EG")).toContain("2026");
    expect(fmtMoney({ amount_minor: "250000", currency: "EGP" }, "en-EG")).toContain("2,500");
    expect(fmtMoney({ amount_minor: "x", currency: "EGP" }, "en-EG")).toBe("x EGP");
    expect(fmtMoney({ amount_minor: "1", currency: "XXX" }, "en-EG")).toBe("1 XXX");
    expect(hoursUntil("2026-11-08T12:00:00Z", new Date("2026-11-08T10:30:00Z"))).toBe(1);
    expect(hoursUntil("2026-11-08T10:00:00Z", new Date("2026-11-08T12:30:00Z"))).toBe(-2);
  });
  it("round-trips base64url and converts WebAuthn JSON", () => {
    const buf = new Uint8Array([251, 255, 0, 1]).buffer;
    expect(new Uint8Array(fromB64u(toB64u(buf)))).toEqual(new Uint8Array(buf));
    expect(requestOptionsFromJson(null)).toBeNull();
    expect(requestOptionsFromJson({})).toBeNull();
    const o = requestOptionsFromJson({ challenge: "AQID", rpId: "a.test", timeout: 5, allowCredentials: [{ id: "AQ", type: "public-key" }] });
    expect(o?.userVerification).toBe("required");
    expect(o?.allowCredentials).toHaveLength(1);
    const json = assertionToJson({ id: "i", rawId: buf, type: "public-key", response: { clientDataJSON: buf, authenticatorData: buf, signature: buf, userHandle: null } } as unknown as PublicKeyCredential);
    expect(json).toMatchObject({ id: "i", response: { signature: toB64u(buf) } });
  });
});
