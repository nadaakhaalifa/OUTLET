import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertTenantTablesProtected, listRlsExceptions, withDbContext } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import { KycTransitionError } from "../src/index.js";
import { DOB_19, IBAN, admin, buildWorld } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});
afterAll(async () => {
  await w.close();
});

const draft = async (applicant: string, over: Record<string, string> = {}): Promise<{ sellerId: string; caseId: string }> => {
  const n = randomUUID().slice(0, 8);
  return w.onboarding.createDraft(applicant, { legal_type: "company", legal_name_ar: "شركة الأمل", commercial_register_no: `CR-${n}`, tax_card_no: `TX-${n}`, governorate_name_ar: "الجيزة", ...over });
};
const docs = async (applicant: string, sellerId: string, kinds = ["commercial_register", "tax_card", "signatory_national_id"] as const): Promise<void> => {
  for (const kind of kinds) await w.onboarding.addDocument(applicant, sellerId, { kind, mediaAssetId: await w.media(applicant) });
};
const state = async (caseId: string): Promise<string> => ((await w.raw.query<{ state: string }>("SELECT state FROM kyc_cases WHERE id = $1", [caseId])).rows[0] as { state: string }).state;

describe("submission gate", () => {
  it("blocks without documents, bank account or legal identity, listing every gap", async () => {
    const u = await w.user();
    const { sellerId } = await w.onboarding.createDraft(u, { legal_type: "sole_trader" });
    await expect(w.onboarding.submit(u, sellerId)).rejects.toMatchObject({
      code: "kyc_incomplete",
      details: ["document:commercial_register", "document:tax_card", "document:signatory_national_id", "bank_account", "legal_name_ar", "commercial_register_no", "tax_card_no", "governorate_name_ar"],
    });
    expect((await w.onboarding.getCase(u, sellerId)).gaps).toContain("bank_account");
  });

  it("blocks without an IBAN even when documents are complete", async () => {
    const u = await w.user();
    const { sellerId, caseId } = await draft(u);
    await docs(u, sellerId);
    await expect(w.onboarding.submit(u, sellerId)).rejects.toMatchObject({ code: "kyc_incomplete", details: ["bank_account"] });
    expect(await state(caseId)).toBe("DRAFT");
  });

  it("blocks a signatory under 21 and stores nothing about them", async () => {
    const u = await w.user({ dob: DOB_19 });
    const { sellerId, caseId } = await draft(u);
    await docs(u, sellerId);
    await w.onboarding.setBankAccount(u, sellerId, { iban: IBAN, accountName: "شركة الأمل" });
    await expect(w.onboarding.submit(u, sellerId)).rejects.toMatchObject({ code: "signatory_under_21" });
    expect(await state(caseId)).toBe("DRAFT");
    expect((await w.raw.query("SELECT 1 FROM seller_signatories WHERE seller_id = $1", [sellerId])).rows).toHaveLength(0);
  });

  it("requires brand authorization when third-party brands are listed", async () => {
    const u = await w.user();
    const { sellerId } = await draft(u);
    await docs(u, sellerId);
    await w.onboarding.setBankAccount(u, sellerId, { iban: IBAN, accountName: "شركة الأمل" });
    await expect(w.onboarding.submit(u, sellerId, { thirdPartyBrands: true })).rejects.toMatchObject({ details: ["document:brand_authorization"] });
  });

  it("rejects an invalid IBAN and a foreign or unready media asset", async () => {
    const u = await w.user();
    const other = await w.user();
    const { sellerId } = await draft(u);
    await expect(w.onboarding.setBankAccount(u, sellerId, { iban: "EG00BAD", accountName: "x" })).rejects.toMatchObject({ code: "validation" });
    await expect(w.onboarding.addDocument(u, sellerId, { kind: "tax_card", mediaAssetId: await w.media(other) })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("happy path and decisions", () => {
  it("DRAFT -> SUBMITTED -> AUTO_CHECKS -> APPROVED, seller active, signatory stores only the boolean", async () => {
    const u = await w.user();
    const { sellerId, caseId } = await draft(u);
    await docs(u, sellerId);
    await w.onboarding.setBankAccount(u, sellerId, { iban: IBAN, accountName: "شركة الأمل" });
    const submitted = await w.onboarding.submit(u, sellerId);
    expect(submitted.state).toBe("AUTO_CHECKS");
    expect((await w.raw.query<{ status: string }>("SELECT status FROM sellers WHERE id = $1", [sellerId])).rows[0]?.status).toBe("kyc_pending");
    const approved = await w.onboarding.decide(admin(["ops"]), caseId, { decision: "approve" });
    expect(approved.state).toBe("APPROVED");
    expect((await w.raw.query<{ status: string }>("SELECT status FROM sellers WHERE id = $1", [sellerId])).rows[0]?.status).toBe("active");
    const sig = (await w.raw.query("SELECT * FROM seller_signatories WHERE seller_id = $1", [sellerId])).rows[0]!;
    expect(sig.age_21_plus).toBe(true);
    expect(Object.keys(sig).sort()).toEqual(["age_21_plus", "age_checked_at", "created_at", "id", "market_id", "seller_id", "user_id"]);
    const log = (await w.raw.query<{ from_state: string; to_state: string; actor_kind: string }>("SELECT from_state, to_state, actor_kind FROM kyc_decisions WHERE case_id = $1 ORDER BY occurred_at", [caseId])).rows;
    expect(log.map((l) => `${l.from_state}>${l.to_state}:${l.actor_kind}`)).toEqual(["DRAFT>SUBMITTED:applicant", "SUBMITTED>AUTO_CHECKS:system", "AUTO_CHECKS>APPROVED:admin"]);
    const ev = (await w.raw.query<{ event_type: string }>("SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY occurred_at", [sellerId])).rows.map((e) => e.event_type);
    expect(ev).toEqual(["seller.created", "seller.kyc_submitted", "seller.kyc_approved"]);
  });

  it("failed IBAN-name match sends the case to NEEDS_INFO, applicant fixes and resubmits", async () => {
    const u = await w.user();
    const { sellerId, caseId } = await draft(u);
    await docs(u, sellerId);
    await w.onboarding.setBankAccount(u, sellerId, { iban: IBAN, accountName: "شخص آخر" });
    expect((await w.onboarding.submit(u, sellerId)).state).toBe("NEEDS_INFO");
    expect((await w.raw.query<{ reason_code: string }>("SELECT reason_code FROM kyc_cases WHERE id = $1", [caseId])).rows[0]?.reason_code).toBe("auto_check_failed");
    expect((await w.raw.query<{ status: string }>("SELECT status FROM seller_bank_accounts WHERE seller_id = $1", [sellerId])).rows[0]?.status).toBe("rejected");
    await w.onboarding.setBankAccount(u, sellerId, { iban: IBAN, accountName: "شركة الأمل" });
    expect((await w.onboarding.submit(u, sellerId)).state).toBe("AUTO_CHECKS");
  });

  it("a rejected document must be replaced before resubmitting", async () => {
    const u = await w.user();
    const { sellerId } = await draft(u);
    await docs(u, sellerId);
    await w.onboarding.setBankAccount(u, sellerId, { iban: IBAN, accountName: "شركة الأمل" });
    w.check.failOcrFor = "tax_card";
    expect((await w.onboarding.submit(u, sellerId)).state).toBe("NEEDS_INFO");
    w.check.failOcrFor = undefined;
    await expect(w.onboarding.submit(u, sellerId)).rejects.toMatchObject({ details: ["document:tax_card"] });
  });

  it("a sanctions hit stays in AUTO_CHECKS for an administrator", async () => {
    const u = await w.user();
    const { sellerId } = await draft(u, { commercial_register_no: "SANCTIONED" });
    await docs(u, sellerId);
    await w.onboarding.setBankAccount(u, sellerId, { iban: IBAN, accountName: "شركة الأمل" });
    expect((await w.onboarding.submit(u, sellerId)).state).toBe("AUTO_CHECKS");
  });

  it("provider outage leaves SUBMITTED and runAutoChecks can be retried", async () => {
    const u = await w.user();
    const { sellerId, caseId } = await draft(u);
    await docs(u, sellerId);
    await w.onboarding.setBankAccount(u, sellerId, { iban: IBAN, accountName: "شركة الأمل" });
    w.check.down = true;
    await expect(w.onboarding.submit(u, sellerId)).rejects.toThrow("provider down");
    expect(await state(caseId)).toBe("SUBMITTED");
    w.check.down = false;
    expect((await w.onboarding.runAutoChecks(caseId)).state).toBe("AUTO_CHECKS");
    expect((await w.onboarding.runAutoChecks(caseId)).state).toBe("AUTO_CHECKS");
  });

  it("admin decisions need a reason code (except approve), the review action, and a valid transition", async () => {
    const u = await w.user();
    const { sellerId, caseId } = await draft(u);
    await docs(u, sellerId);
    await w.onboarding.setBankAccount(u, sellerId, { iban: IBAN, accountName: "شركة الأمل" });
    await expect(w.onboarding.decide(admin(), caseId, { decision: "approve" })).rejects.toBeInstanceOf(KycTransitionError); // still DRAFT
    await w.onboarding.submit(u, sellerId);
    await expect(w.onboarding.decide(admin(), caseId, { decision: "reject" })).rejects.toMatchObject({ code: "reason_required" });
    await expect(w.onboarding.decide(admin(["support"]), caseId, { decision: "approve" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(w.onboarding.decide({ ...admin(), kind: "shopper" }, caseId, { decision: "approve" })).rejects.toMatchObject({ code: "forbidden" });
    const r = await w.onboarding.decide(admin(["trust_safety"]), caseId, { decision: "reject", reasonCode: "counterfeit_risk", note: "see ticket" });
    expect(r.state).toBe("REJECTED");
    expect((await w.raw.query<{ status: string }>("SELECT status FROM sellers WHERE id = $1", [sellerId])).rows[0]?.status).toBe("closed");
    await expect(w.onboarding.decide(admin(), caseId, { decision: "approve" })).rejects.toBeInstanceOf(KycTransitionError);
    await expect(w.onboarding.submit(u, sellerId)).rejects.toBeInstanceOf(KycTransitionError);
  });

  it("suspension: APPROVED only, reason required, emits seller.suspended", async () => {
    const u = await w.user();
    const { sellerId, caseId } = await w.approvedSeller(u);
    await expect(w.onboarding.suspend(admin(["ops"]), sellerId, { reasonCode: "" })).rejects.toBeDefined();
    await expect(w.onboarding.suspend(admin(["finance"]), sellerId, { reasonCode: "price_fraud" })).rejects.toMatchObject({ code: "forbidden" });
    expect((await w.onboarding.suspend(admin(["ops"]), sellerId, { reasonCode: "price_fraud" })).state).toBe("SUSPENDED");
    expect((await w.raw.query<{ status: string }>("SELECT status FROM sellers WHERE id = $1", [sellerId])).rows[0]?.status).toBe("suspended");
    await expect(w.onboarding.suspend(admin(["ops"]), sellerId, { reasonCode: "again" })).rejects.toBeInstanceOf(KycTransitionError);
    expect((await w.raw.query("SELECT 1 FROM outbox_events WHERE event_type = 'seller.suspended' AND aggregate_id = $1", [sellerId])).rows).toHaveLength(1);
    expect(caseId).toBeDefined();
  });
});

describe("isolation and data protection", () => {
  it("another user cannot see, edit or submit someone else's application (not_found)", async () => {
    const a = await w.user();
    const b = await w.user();
    const { sellerId } = await draft(a);
    await expect(w.onboarding.getCase(b, sellerId)).rejects.toMatchObject({ code: "not_found" });
    await expect(w.onboarding.setBankAccount(b, sellerId, { iban: IBAN, accountName: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(w.onboarding.addDocument(b, sellerId, { kind: "tax_card", mediaAssetId: await w.media(b) })).rejects.toMatchObject({ code: "not_found" });
    await expect(w.onboarding.submit(b, sellerId)).rejects.toMatchObject({ code: "not_found" });
    await expect(w.onboarding.updateLegalIdentity(b, sellerId, { legal_name_ar: "x" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("the applicant cannot write once submitted (editable-state RLS and service)", async () => {
    const u = await w.user();
    const { sellerId } = await w.approvedSeller(u);
    await expect(w.onboarding.setBankAccount(u, sellerId, { iban: IBAN, accountName: "x" })).rejects.toMatchObject({ code: "conflict" });
    // Bypass the service: the database itself refuses the INSERT.
    await expect(
      w.app.transaction(async (tx) => {
        await tx.query("SELECT set_config('app.ctx','user',true), set_config('app.current_market_id','EG',true), set_config('app.current_user_id',$1,true)", [u]);
        await tx.query("INSERT INTO kyc_documents (id, case_id, seller_id, market_id, kind, media_asset_id) SELECT $1, id, seller_id, market_id, 'tax_card', $2 FROM kyc_cases WHERE seller_id = $3", [randomUUID(), randomUUID(), sellerId]);
      }),
    ).rejects.toBeDefined();
  });

  it("the applicant cannot forge a case state, a signatory or a plan under outlet_app", async () => {
    const u = await w.user();
    const { sellerId, caseId } = await draft(u);
    const attempt = (sql: string, params: unknown[]): Promise<unknown> =>
      w.app.transaction(async (tx) => {
        await tx.query("SELECT set_config('app.ctx','user',true), set_config('app.current_market_id','EG',true), set_config('app.current_user_id',$1,true)", [u]);
        return tx.query(sql, params);
      });
    await expect(attempt("UPDATE kyc_cases SET state = 'APPROVED' WHERE id = $1", [caseId])).rejects.toThrow(/permission denied/u);
    await expect(attempt("INSERT INTO seller_signatories (id, seller_id, market_id, user_id, age_21_plus, age_checked_at) VALUES ($1,$2,'EG',$3,true,now())", [randomUUID(), sellerId, u])).rejects.toThrow(/permission denied/u);
    await expect(attempt("INSERT INTO seller_plan_assignments (id, seller_id, market_id, effective_from) VALUES ($1,$2,'EG',now())", [randomUUID(), sellerId])).rejects.toThrow(/permission denied/u);
    await expect(attempt("INSERT INTO kyc_decisions (id, case_id, seller_id, market_id, from_state, to_state, actor_kind) VALUES ($1,$2,$3,'EG','DRAFT','APPROVED','admin')", [randomUUID(), caseId, sellerId])).rejects.toThrow(/permission denied/u);
  });

  it("kyc_decisions is append-only even for the privileged client", async () => {
    const u = await w.user();
    const { caseId } = await w.approvedSeller(u);
    await expect(w.raw.query("UPDATE kyc_decisions SET reason_code = 'x' WHERE case_id = $1", [caseId])).rejects.toThrow(/append-only/u);
    await expect(w.raw.query("DELETE FROM kyc_decisions WHERE case_id = $1", [caseId])).rejects.toThrow(/append-only/u);
    await expect(w.raw.query("TRUNCATE kyc_decisions")).rejects.toThrow(/append-only/u);
  });

  it("stores the IBAN only encrypted + blind index; no plaintext anywhere in the row", async () => {
    const u = await w.user();
    const { sellerId } = await draft(u);
    await w.onboarding.setBankAccount(u, sellerId, { iban: `${IBAN.slice(0, 4)} ${IBAN.slice(4)}`.toLowerCase(), accountName: "شركة الأمل" });
    const row = (await w.raw.query("SELECT * FROM seller_bank_accounts WHERE seller_id = $1", [sellerId])).rows[0]!;
    const dump = JSON.stringify(row, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v));
    expect(dump).not.toContain(IBAN);
    expect(dump).not.toContain(IBAN.slice(4, 20));
    expect(dump).not.toContain("شركة");
    expect(row.iban_last4).toBe(IBAN.slice(-4));
    expect(Buffer.from(row.iban_bidx as Uint8Array).equals(w.hasher.hmac("iban", `EG:${IBAN}`))).toBe(true);
    expect(await w.cipher.decrypt(row.iban_ct as Uint8Array, "seller_bank_accounts.iban_ct")).toBe(IBAN);
    await expect(w.cipher.decrypt(row.iban_ct as Uint8Array, "users.phone_ct")).rejects.toBeDefined();
    // a second call updates in place (one live bank row)
    await w.onboarding.setBankAccount(u, sellerId, { iban: IBAN, accountName: "شركة الأمل" });
    expect((await w.raw.query("SELECT 1 FROM seller_bank_accounts WHERE seller_id = $1", [sellerId])).rows).toHaveLength(1);
  });

  it("a duplicate commercial register number is a conflict, not a leak of the other seller", async () => {
    const a = await w.user();
    const b = await w.user();
    await draft(a, { commercial_register_no: "CR-DUP-1" });
    await expect(draft(b, { commercial_register_no: "CR-DUP-1" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("document rows hold pointers only (no content columns)", async () => {
    const cols = (await w.raw.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'kyc_documents' ORDER BY ordinal_position")).rows.map((c) => c.column_name);
    expect(cols).toEqual(["id", "case_id", "seller_id", "market_id", "kind", "media_asset_id", "status", "checks", "expires_on", "created_at", "updated_at"]);
  });
});

describe("RLS audit", () => {
  it("passes the ADR-0011 audit and adds exactly the reviewed exception policies (one auth read, seller.kyc worker policies)", async () => {
    await expect(assertTenantTablesProtected(w.raw)).resolves.toBeDefined();
    const mine = (await listRlsExceptions(w.raw)).filter((e) => ["store_members", "stores", "kyc_cases", "kyc_documents", "kyc_decisions", "seller_signatories", "seller_bank_accounts", "seller_plan_assignments"].includes(e.table));
    expect(mine.map((e) => `${e.table}.${e.policy}:${e.role}:${e.cmd}`)).toEqual([
      "kyc_cases.kyc_cases__worker_seller_kyc_insert:outlet_worker:insert",
      "kyc_cases.kyc_cases__worker_seller_kyc_read:outlet_worker:select",
      "kyc_cases.kyc_cases__worker_seller_kyc_update:outlet_worker:update",
      "kyc_decisions.kyc_decisions__worker_seller_kyc:outlet_worker:all",
      "kyc_documents.kyc_documents__worker_seller_kyc:outlet_worker:all",
      "seller_bank_accounts.seller_bank_accounts__worker_seller_kyc:outlet_worker:all",
      "seller_plan_assignments.seller_plan_assignments__worker_seller_kyc:outlet_worker:all",
      "seller_signatories.seller_signatories__worker_seller_kyc_insert:outlet_worker:insert",
      "seller_signatories.seller_signatories__worker_seller_kyc_read:outlet_worker:select",
      "seller_signatories.seller_signatories__worker_seller_kyc_update:outlet_worker:update",
      "store_members.store_members__auth_my_memberships:outlet_auth:select",
      "store_members.store_members__worker_seller_kyc:outlet_worker:insert",
      "store_members.store_members__worker_seller_kyc_accept:outlet_worker:update",
      "store_members.store_members__worker_seller_kyc_read:outlet_worker:select",
      "stores.stores__worker_seller_kyc:outlet_worker:select",
    ]);
  });
});

describe("seller.kyc job pinning (B2)", () => {
  const job = <T>(userId: string | undefined, fn: (tx: Queryable) => Promise<T>): Promise<T> =>
    withDbContext(w.deps.worker, { kind: "worker", marketId: "EG", job: "seller.kyc", ...(userId === undefined ? {} : { userId }) }, fn);
  const insertCase = (sellerId: string, applicant: string) =>
    (tx: Queryable) => tx.query("INSERT INTO kyc_cases (id, seller_id, market_id, applicant_user_id) VALUES ($1,$2,'EG',$3)", [randomUUID(), sellerId, applicant]);
  const insertSeller = (tx: Queryable) => {
    const id = randomUUID();
    return tx.query("INSERT INTO sellers (id, home_market_id, market_id, legal_type, status) VALUES ($1,'EG','EG','company','draft')", [id]).then(() => id);
  };

  it("a job narrowed to user A cannot create a case for user B, nor a job with no narrowed user", async () => {
    const a = await w.user();
    const b = await w.user();
    await expect(job(a, async (tx) => insertCase(await insertSeller(tx), b)(tx))).rejects.toThrow(/row-level security/);
    await expect(job(undefined, async (tx) => insertCase(await insertSeller(tx), a)(tx))).rejects.toThrow(/row-level security/);
    await expect(job(a, async (tx) => insertCase(await insertSeller(tx), a)(tx))).resolves.toBeDefined();
  });

  it("a signatory row can only be written for the narrowed user", async () => {
    const a = await w.user();
    const b = await w.user();
    const { sellerId } = await draft(a);
    const ins = (u: string) => (tx: Queryable) => tx.query("INSERT INTO seller_signatories (id, seller_id, market_id, user_id, age_21_plus, age_checked_at) VALUES ($1,$2,'EG',$3,true,now())", [randomUUID(), sellerId, u]);
    await expect(job(a, ins(b))).rejects.toThrow(/row-level security/);
    await expect(job(undefined, ins(a))).rejects.toThrow(/row-level security/);
  });

  it("a case cannot be re-pointed at another applicant or seller (column grant)", async () => {
    const a = await w.user();
    const b = await w.user();
    const { caseId } = await draft(a);
    await expect(job(undefined, (tx) => tx.query("UPDATE kyc_cases SET applicant_user_id = $2 WHERE id = $1", [caseId, b]))).rejects.toThrow(/permission denied/);
  });
});

describe("KYC check atomicity (B4)", () => {
  it("a provider failure between the two KYC transactions leaves no half-written check_results", async () => {
    const u = await w.user();
    const { sellerId, caseId } = await draft(u);
    await docs(u, sellerId);
    await w.onboarding.setBankAccount(u, sellerId, { iban: IBAN, accountName: "شركة الأمل" });
    w.check.down = true;
    await expect(w.onboarding.submit(u, sellerId)).rejects.toThrow("provider down");
    const c = (await w.raw.query<{ state: string; check_results: unknown[]; provider: string | null }>("SELECT state, check_results, provider FROM kyc_cases WHERE id = $1", [caseId])).rows[0]!;
    expect(c).toMatchObject({ state: "SUBMITTED", check_results: [], provider: null });
    const docsChecked = (await w.raw.query<{ checks: unknown[] }>("SELECT checks FROM kyc_documents WHERE case_id = $1", [caseId])).rows;
    expect(docsChecked.every((d) => d.checks.length === 0)).toBe(true);
    w.check.down = false;
  });
});
