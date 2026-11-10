import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "@outlet/policy";
import { IBAN, admin, buildWorld } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });

const draft = async (applicant: string, over: Record<string, string> = {}): Promise<{ sellerId: string; caseId: string }> => {
  const n = randomUUID().slice(0, 8);
  return w.onboarding.createDraft(applicant, { legal_type: "company", legal_name_ar: "شركة الأمل", commercial_register_no: `CR-${n}`, tax_card_no: `TX-${n}`, governorate_name_ar: "الجيزة", ...over });
};
const docs = async (applicant: string, sellerId: string): Promise<void> => {
  for (const kind of ["commercial_register", "tax_card", "signatory_national_id"] as const) await w.onboarding.addDocument(applicant, sellerId, { kind, mediaAssetId: await w.media(applicant) });
};
const complete = async (applicant: string): Promise<{ sellerId: string; caseId: string }> => {
  const d = await draft(applicant);
  await docs(applicant, d.sellerId);
  await w.onboarding.setBankAccount(applicant, d.sellerId, { iban: IBAN, accountName: "شركة الأمل" });
  return d;
};
const state = async (caseId: string): Promise<string> => (await w.raw.query<{ state: string }>("SELECT state FROM kyc_cases WHERE id = $1", [caseId])).rows[0]?.state ?? "";

describe("createDraft guards", () => {
  it("only an active user of the market can start onboarding: a suspended or unknown user is not found and nothing is created", async () => {
    const u = await w.user();
    await w.raw.query("UPDATE users SET status = 'suspended' WHERE id = $1", [u]);
    await expect(w.onboarding.createDraft(u, { legal_type: "company" })).rejects.toMatchObject({ code: "not_found" });
    await expect(w.onboarding.createDraft(randomUUID(), { legal_type: "company" })).rejects.toMatchObject({ code: "not_found" });
    expect((await w.raw.query("SELECT 1 FROM sellers s JOIN kyc_cases c ON c.seller_id = s.id WHERE c.applicant_user_id = $1", [u])).rows).toHaveLength(0);
  });

  it("a second draft for the same applicant reports the existing one; a taken commercial register number is a conflict", async () => {
    const u = await w.user();
    const first = await draft(u, { commercial_register_no: "CR-DUP-1" });
    await expect(w.onboarding.createDraft(u, { legal_type: "company" })).rejects.toMatchObject({ sellerId: first.sellerId, caseId: first.caseId });
    const other = await w.user();
    await expect(draft(other, { commercial_register_no: "CR-DUP-1" })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("edits are refused once the case left the applicant's hands", () => {
  it("legal identity: an empty patch is a no-op, a submitted case is a conflict, a taken register number is a conflict", async () => {
    const u = await w.user();
    const { sellerId, caseId } = await complete(u);
    await expect(w.onboarding.updateLegalIdentity(u, sellerId, {})).resolves.toBeUndefined();
    const v = await draft(await w.user(), { commercial_register_no: "CR-TAKEN-9" });
    await expect(w.onboarding.updateLegalIdentity(u, sellerId, { commercial_register_no: "CR-TAKEN-9" })).rejects.toMatchObject({ code: "conflict" });
    expect(v.sellerId).not.toBe(sellerId);
    await w.onboarding.submit(u, sellerId);
    expect(["AUTO_CHECKS", "NEEDS_INFO"]).toContain(await state(caseId));
    await expect(w.onboarding.updateLegalIdentity(u, sellerId, { legal_name_ar: "اسم جديد" })).rejects.toMatchObject({ code: "conflict" });
    expect((await w.raw.query<{ legal_name_ar: string }>("SELECT legal_name_ar FROM sellers WHERE id = $1", [sellerId])).rows[0]?.legal_name_ar).toBe("شركة الأمل");
  });

  it("documents: a submitted case refuses new ones; the same media asset cannot be attached twice; another seller's case is not found", async () => {
    const u = await w.user();
    const d = await draft(u);
    const media = await w.media(u);
    await w.onboarding.addDocument(u, d.sellerId, { kind: "tax_card", mediaAssetId: media });
    await expect(w.onboarding.addDocument(u, d.sellerId, { kind: "tax_card", mediaAssetId: media })).rejects.toMatchObject({ code: "conflict" });
    const stranger = await w.user();
    await expect(w.onboarding.addDocument(stranger, d.sellerId, { kind: "commercial_register", mediaAssetId: await w.media(stranger) })).rejects.toMatchObject({ code: "not_found" });
    const done = await complete(await w.user());
    await w.raw.query("UPDATE kyc_cases SET state = 'SUBMITTED', submitted_at = now() WHERE id = $1", [done.caseId]);
    const owner = (await w.raw.query<{ applicant_user_id: string }>("SELECT applicant_user_id FROM kyc_cases WHERE id = $1", [done.caseId])).rows[0]?.applicant_user_id ?? "";
    await expect(w.onboarding.addDocument(owner, done.sellerId, { kind: "brand_authorization", mediaAssetId: await w.media(owner) })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("submit and automatic checks", () => {
  it("a signatory with no date of birth on file cannot submit; nothing is stored about them", async () => {
    const u = await w.user();
    const { sellerId, caseId } = await complete(u);
    await w.raw.query("UPDATE users SET dob_ct = NULL WHERE id = $1", [u]);
    await expect(w.onboarding.submit(u, sellerId)).rejects.toMatchObject({ code: "kyc_incomplete", details: ["signatory_dob"] });
    expect(await state(caseId)).toBe("DRAFT");
    expect((await w.raw.query("SELECT 1 FROM seller_signatories WHERE seller_id = $1", [sellerId])).rows).toHaveLength(0);
  });

  it("runAutoChecks: an unknown case is not found; a case that is not SUBMITTED is returned unchanged and the provider is not called", async () => {
    await expect(w.onboarding.runAutoChecks(randomUUID())).rejects.toMatchObject({ code: "not_found" });
    const u = await w.user();
    const { caseId } = await draft(u);
    const calls = w.check.calls.length;
    expect((await w.onboarding.runAutoChecks(caseId)).state).toBe("DRAFT");
    expect(w.check.calls.length).toBe(calls);
  });

  it("a SUBMITTED case that lost its bank account cannot be checked (kyc_incomplete) and stays SUBMITTED", async () => {
    const u = await w.user();
    const { sellerId, caseId } = await complete(u);
    await w.raw.query("UPDATE kyc_cases SET state = 'SUBMITTED', submitted_at = now() WHERE id = $1", [caseId]);
    await w.raw.query("UPDATE seller_bank_accounts SET status = 'rejected' WHERE seller_id = $1", [sellerId]);
    await expect(w.onboarding.runAutoChecks(caseId)).rejects.toMatchObject({ code: "kyc_incomplete", details: ["bank_account"] });
    expect(await state(caseId)).toBe("SUBMITTED");
  });

  it("an IBAN-name mismatch rejects the bank account and sends the case back for information", async () => {
    const u = await w.user();
    const { sellerId, caseId } = await draft(u);
    await docs(u, sellerId);
    await w.onboarding.setBankAccount(u, sellerId, { iban: IBAN, accountName: "اسم مختلف تماما" });
    expect((await w.onboarding.submit(u, sellerId)).state).toBe("NEEDS_INFO");
    expect(await state(caseId)).toBe("NEEDS_INFO");
    expect((await w.raw.query<{ status: string }>("SELECT status FROM seller_bank_accounts WHERE seller_id = $1", [sellerId])).rows[0]?.status).toBe("rejected");
  });
});

describe("decide requires a real administrator identity", () => {
  it("an admin principal without a user id cannot decide, even with the right role", async () => {
    const u = await w.user();
    const { sellerId, caseId } = await complete(u);
    await w.onboarding.submit(u, sellerId);
    const anon: Principal = { kind: "admin", marketId: "EG", roles: ["ops"], scopes: [] };
    await expect(w.onboarding.decide(anon, caseId, { decision: "approve" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await state(caseId)).toBe("AUTO_CHECKS");
    expect((await w.onboarding.decide(admin(["ops"]), caseId, { decision: "approve" })).state).toBe("APPROVED");
  });
});
