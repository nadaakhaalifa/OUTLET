import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_A, APP_B, IDEM, TOKENS, bearer, createHarness, type Harness } from "./test/harness";
import { U } from "./test/fixtures";

let h: Harness;
let seq = 100;
beforeEach(async () => {
  h = await createHarness();
}, 60_000);
afterEach(async () => {
  await h.close();
});

const key = (): Record<string, string> => ({ "Idempotency-Key": IDEM(++seq) });
const post = (path: string, token: string | null, body: unknown, k: Record<string, string> = key()) => {
  const r = h.http().post(path).set(k);
  return (token === null ? r : r.set(bearer(token))).send(body as object);
};
const START = (id: string) => `/v1/seller/applications/${id}/domain-verification`;
const CONFIRM = (id: string) => `/v1/seller/applications/${id}/domain-verification/confirm`;
const TM = (id: string) => `/v1/admin/brand-applications/${id}/trademark-lookup`;
const CONFLICT = (id: string) => `/v1/admin/brand-applications/${id}/conflict-resolution`;

describe("startBrandDomainVerification / confirmBrandDomainVerification", () => {
  it("owner starts DNS verification, sees the record, confirms once the TXT exists", async () => {
    const s = await post(START(APP_A.applicationId), TOKENS.sellerA, { method: "dns_txt" });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ method: "dns_txt", domain: "lumen-atelier.com", status: "pending", txt_record_name: "_zoutlet-verify.lumen-atelier.com" });
    expect(s.body.txt_record_value).toMatch(/^zoutlet-site-verification=/);
    expect((await post(CONFIRM(APP_A.applicationId), TOKENS.sellerA, {})).body.status).toBe("pending");
    h.dns.set(s.body.txt_record_name as string, [s.body.txt_record_value as string]);
    const c = await post(CONFIRM(APP_A.applicationId), TOKENS.sellerA, {});
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: "verified" });
    expect(typeof c.body.verified_at).toBe("string");
  });

  it("replays an idempotent request and rejects a missing key", async () => {
    const k = key();
    const a = await post(START(APP_A.applicationId), TOKENS.sellerA, { method: "dns_txt" }, k);
    const b = await post(START(APP_A.applicationId), TOKENS.sellerA, { method: "dns_txt" }, k);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect((await h.http().post(START(APP_A.applicationId)).set(bearer(TOKENS.sellerA)).send({ method: "dns_txt" })).status).toBe(400);
  });

  it("BOLA: another seller's application and an unknown application are both 404 with the same body", async () => {
    const foreign = await post(START(APP_A.applicationId), TOKENS.sellerB, { method: "dns_txt" });
    const missing = await post(START(U(98765)), TOKENS.sellerB, { method: "dns_txt" });
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    const strip = (b: Record<string, unknown>) => ({ ...b, request_id: undefined });
    expect(strip(foreign.body)).toEqual(strip(missing.body));
    expect((await post(CONFIRM(APP_A.applicationId), TOKENS.sellerB, {})).status).toBe(404);
  });

  it("401 without or with the wrong audience, 403 for a missing scope or suspended account, 400 for bad input", async () => {
    expect((await post(START(APP_A.applicationId), null, { method: "dns_txt" })).status).toBe(401);
    expect((await post(START(APP_A.applicationId), TOKENS.shopper, { method: "dns_txt" })).status).toBe(401);
    expect((await post(START(APP_A.applicationId), TOKENS.ops, { method: "dns_txt" })).status).toBe(401);
    expect((await post(START(APP_A.applicationId), TOKENS.sellerNoScope, { method: "dns_txt" })).status).toBe(403);
    expect((await post(START(APP_A.applicationId), TOKENS.suspendedSeller, { method: "dns_txt" })).status).toBe(403);
    expect((await post(START(APP_A.applicationId), TOKENS.sellerA, { method: "carrier_pigeon" })).status).toBe(400);
    expect((await post(START(APP_A.applicationId), TOKENS.sellerA, { method: "dns_txt", extra: 1 })).status).toBe(400);
    expect((await post(CONFIRM(APP_A.applicationId), TOKENS.sellerA, { code: "12ab" })).status).toBe(400);
    expect((await post(START("not-a-uuid"), TOKENS.sellerA, { method: "dns_txt" })).status).toBe(400);
  });

  it("rate limits start to 5 per hour per user", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) codes.push((await post(START(APP_A.applicationId), TOKENS.sellerA, { method: "dns_txt" })).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it("email flow: masked address, wrong code with attempts remaining, then success; invalid domains are 422", async () => {
    const s = await post(START(APP_B.applicationId), TOKENS.sellerB, { method: "email", email_local_part: "webmaster" });
    expect(s.status).toBe(200);
    expect(s.body.email_sent_to_masked).toBe("w********@other-brand.com");
    const code = h.email.sent[h.email.sent.length - 1]?.code as string;
    const wrong = await post(CONFIRM(APP_B.applicationId), TOKENS.sellerB, { code: code === "000000" ? "111111" : "000000" });
    expect(wrong.status).toBe(422);
    expect(wrong.body).toMatchObject({ code: "invalid_code", attempts_remaining: 4 });
    expect((await post(CONFIRM(APP_B.applicationId), TOKENS.sellerB, {})).status).toBe(400);
    expect((await post(CONFIRM(APP_B.applicationId), TOKENS.sellerB, { code })).body.status).toBe("verified");
    h.ownership.seed({ ...APP_B, applicationId: U(778), websiteDomain: "gmail.com" });
    const bad = await post(START(U(778)), TOKENS.sellerB, { method: "dns_txt" });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: "invalid_domain", reason: "free_mail" });
  });

  it("confirm before start is a 409 and a domain-less application is a 422", async () => {
    h.ownership.seed({ ...APP_A, applicationId: U(779), websiteDomain: null });
    expect((await post(START(U(779)), TOKENS.sellerA, { method: "dns_txt" })).body.code).toBe("domain_not_set");
    h.ownership.seed({ ...APP_A, applicationId: U(780), websiteDomain: "fresh-one.com" });
    expect((await post(CONFIRM(U(780)), TOKENS.sellerA, {})).body.code).toBe("verification_not_started");
    h.ownership.seed({ ...APP_A, applicationId: U(781), websiteDomain: "http://10.0.0.1" });
    const r = await post(START(U(781)), TOKENS.sellerA, { method: "dns_txt" });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: "invalid_domain", reason: "not_a_hostname" });
  });
});

describe("adminRecordTrademarkLookup", () => {
  it("ops records a manual lookup; the wire follows TrademarkEvidence", async () => {
    const r = await post(TM(APP_A.applicationId), TOKENS.ops, {
      mode: "manual",
      manual: { source: "MANUAL", register_number: "123", found: true, owner_name: "Lumen Atelier SAS", status: "registered", classes: [25] },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ source: "MANUAL", register_number: "123", found: true, owner_matches_applicant: "yes", classes: [25] });
    expect(Object.keys(r.body).sort()).toEqual(["classes", "found", "id", "owner_matches_applicant", "owner_name", "register_number", "retrieved_at", "source", "status"]);
  });
  it("auto lookup uses the registry fixture; no claimed trademark is 422", async () => {
    h.registry.seed("EUIPO", "018123456", { kind: "found", record: { ownerName: "Someone Else Ltd", markText: "X", classes: [25], status: "registered", registeredOn: null, expiresOn: null } });
    const r = await post(TM(APP_A.applicationId), TOKENS.trust, { mode: "auto" });
    expect(r.body).toMatchObject({ source: "EUIPO", owner_matches_applicant: "no" });
    expect((await post(TM(APP_B.applicationId), TOKENS.trust, { mode: "auto" })).body.code).toBe("no_trademark_claimed");
  });
  it("authz: 401 anonymous/wrong audience, 403 support and non-passkey, 404 unknown, 400 bad body", async () => {
    const body = { mode: "auto" };
    expect((await post(TM(APP_A.applicationId), null, body)).status).toBe(401);
    expect((await post(TM(APP_A.applicationId), TOKENS.sellerA, body)).status).toBe(401);
    expect((await post(TM(APP_A.applicationId), TOKENS.shopper, body)).status).toBe(401);
    expect((await post(TM(APP_A.applicationId), TOKENS.support, body)).status).toBe(403);
    expect((await post(TM(APP_A.applicationId), TOKENS.opsBasic, body)).status).toBe(403);
    expect((await post(TM(U(4242)), TOKENS.ops, body)).status).toBe(404);
    expect((await post(TM(APP_A.applicationId), TOKENS.ops, { mode: "manual" })).status).toBe(400);
    expect((await post(TM(APP_A.applicationId), TOKENS.ops, { mode: "auto", manual: { source: "MANUAL", register_number: "1", found: false } })).status).toBe(400);
  });
});

describe("adminResolveBrandClaimConflict", () => {
  const C = U(790);
  it("opens a silent conflict, then trust_safety resolves; ops cannot; replay is 200; a different outcome is 409", async () => {
    h.ownership.seed({ ...APP_A, applicationId: C, applicantId: APP_B.applicantId, brandName: "Lumen Atelier", websiteDomain: "lumen-atelier.com" });
    await post(START(APP_A.applicationId), TOKENS.sellerA, { method: "dns_txt" });
    const start = await post(START(C), TOKENS.sellerB, { method: "dns_txt" });
    expect(start.status).toBe(200);
    expect(start.body.status).toBe("pending");
    expect(JSON.stringify(start.body)).not.toMatch(/conflict|duplicate/);
    const body = { outcome: "keep_first", internal_note: "first verified claim wins" };
    expect((await post(CONFLICT(C), TOKENS.ops, body)).status).toBe(403);
    expect((await post(CONFLICT(C), TOKENS.support, body)).status).toBe(403);
    expect((await post(CONFLICT(C), TOKENS.sellerB, body)).status).toBe(401);
    expect((await post(CONFLICT(C), null, body)).status).toBe(401);
    expect((await post(CONFLICT(C), TOKENS.trust, { outcome: "nope", internal_note: "x" })).status).toBe(400);
    expect((await post(CONFLICT(C), TOKENS.trust, { outcome: "keep_first" })).status).toBe(400);
    const ok = await post(CONFLICT(C), TOKENS.trust, body);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "resolved", outcome: "keep_first" });
    expect(ok.body.application_ids).toContain(C);
    expect((await post(CONFLICT(C), TOKENS.trust, body)).status).toBe(200);
    expect((await post(CONFLICT(C), TOKENS.trust, { outcome: "reject_all", internal_note: "changed my mind" })).status).toBe(409);
    expect((await post(CONFLICT(U(31337)), TOKENS.trust, body)).status).toBe(404);
  });
  it("conflict wire never leaks the internal note", async () => {
    h.ownership.seed({ ...APP_A, applicationId: C, applicantId: APP_B.applicantId, brandName: "Lumen Atelier", websiteDomain: "lumen-atelier.com" });
    await post(START(APP_A.applicationId), TOKENS.sellerA, { method: "dns_txt" });
    await post(START(C), TOKENS.sellerB, { method: "dns_txt" });
    const r = await post(CONFLICT(C), TOKENS.trust, { outcome: "keep_first", internal_note: "SECRET-NOTE" });
    expect(JSON.stringify(r.body)).not.toContain("SECRET-NOTE");
    const outbox = JSON.stringify(h.store.outbox);
    expect(outbox).not.toContain("SECRET-NOTE");
    expect(outbox).not.toContain("lumen-atelier.com");
  });
});
