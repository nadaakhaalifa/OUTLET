import { describe, expect, it } from "vitest";
import {
  InMemoryAdminAudit,
  InMemoryBrandApplicationsAdmin,
  InMemoryBrandVerification,
  type BrandApplicationRecord,
  type BrandReview,
} from "../modules/admin";
import { AuthSellerMemberships, InMemoryBrandReviewOverlay, SellersDocumentAccess, SellersReviewAdapter } from "./brand-adapters";
import { composeBrandOnboarding } from "./brand-wiring";
import {
  InMemoryConflictQueue,
  InMemoryInboxRunner,
  InMemoryProvisioningApplications,
  InMemoryProvisioningEvents,
  InMemorySellerMemberships,
  InMemoryStoreOnboarding,
  InMemoryStoreRepository,
  RecordingBrandNotifier,
  deterministicStoreId,
} from "../modules/stores";
import type { BrandApplicationsAdminPort as SellersAdminPort } from "../modules/sellers";

const ADMIN_A = "0192f3a4-5b6c-7d8e-9f01-0000000000a1";
const ADMIN_B = "0192f3a4-5b6c-7d8e-9f01-0000000000a2";
const APPLICANT = "0192f3a4-5b6c-7d8e-9f01-0000000000c1";
const APP = "0192f3a4-5b6c-7d8e-9f01-000000000501";
const NOW = 1_800_000_000_000;
const clock = { nowMs: () => NOW };
type Meta = Parameters<BrandReview["claim"]>[0];
const meta = (id: string): Meta => ({
  access: { actorId: id, standing: ["ops"], effective: ["ops"], breakGlassLive: false, passkey: true },
  requestId: "req-1",
});

const record = (over: Partial<BrandApplicationRecord> = {}): BrandApplicationRecord => ({
  id: APP,
  version: 1,
  status: "IN_REVIEW",
  brandName: "Nile Basics",
  brandKind: "local",
  country: "EG",
  applicantUserId: APPLICANT,
  applicantShopperUserId: null,
  applicantPhoneHash: null,
  brandDomain: null,
  assigneeId: null,
  submittedAtMs: NOW - 1000,
  decisionDueAtMs: NOW + 1000,
  appeal: false,
  highRiskCountry: false,
  riskScore: null,
  pendingCosign: null,
  claimConflictOpen: false,
  duplicateClaimApplicationIds: [],
  requestedItems: [],
  decision: null,
  internalNotes: [],
  history: [],
  storeId: null,
  provisioningFailure: null,
  createdAtMs: NOW - 2000,
  updatedAtMs: NOW - 1000,
  ...over,
});

describe("composeBrandOnboarding: approval to store to owner membership", () => {
  function build() {
    const applications = new InMemoryBrandApplicationsAdmin();
    const verification = new InMemoryBrandVerification();
    const audit = new InMemoryAdminAudit();
    const stores = new InMemoryStoreRepository([]);
    const memberships = new InMemorySellerMemberships();
    const notifier = new RecordingBrandNotifier();
    const provApps = new InMemoryProvisioningApplications();
    const wiring = composeBrandOnboarding({
      stores,
      audit,
      clock,
      real: {
        applications,
        verification,
        documents: verification,
        memberships,
        notifier,
        provisioningApplications: provApps,
        onboarding: new InMemoryStoreOnboarding(),
        conflicts: new InMemoryConflictQueue(),
        events: new InMemoryProvisioningEvents(),
        inbox: new InMemoryInboxRunner(),
      },
    });
    return { applications, verification, audit, stores, memberships, notifier, provApps, wiring };
  }

  it("approve -> event -> store exists -> applicant is owner; replaying the event creates no second store", async () => {
    const t = build();
    t.applications.seed(record({ assigneeId: ADMIN_A }));
    t.verification.setReport(APP, { checks: [], dualApprovalRequired: false, riskScore: null });
    const r = await t.wiring.review.decide(meta(ADMIN_A), APP, { decision: "approve", reasonCode: "ok" });
    expect(r.kind).toBe("ok");
    const ev = t.applications.outbox.find((e) => e.type === "brand_application.approved");
    if (ev === undefined) throw new Error("approved event missing");

    const msg = { messageId: "0192f3a4-5b6c-7d8e-9f01-000000000901", type: ev.type, payload: ev.payload };
    expect((await t.wiring.consumer.handle(msg)).kind).toBe("provisioned");
    expect((await t.wiring.consumer.handle(msg)).kind).toBe("duplicate");
    expect((await t.wiring.consumer.handle({ ...msg, messageId: "0192f3a4-5b6c-7d8e-9f01-000000000902" })).kind).toBe("provisioned");

    const storeId = deterministicStoreId(APP);
    expect(await t.stores.all()).toHaveLength(1);
    expect((await t.stores.findById(storeId))?.sellerId).toBe(APPLICANT);
    expect(t.memberships.storesOwnedBy(APPLICANT)).toEqual([storeId]);
    expect(t.notifier.sent.map((n) => n.templateKey)).toEqual(["brand_application_approved"]);
  });

  it("rejection never creates a store or a membership", async () => {
    const t = build();
    t.applications.seed(record({ assigneeId: ADMIN_A }));
    const r = await t.wiring.review.decide(meta(ADMIN_A), APP, {
      decision: "reject",
      reasonCode: "ownership_not_proven",
      publicMessageAr: "لم يثبت",
      publicMessageEn: "Not proven",
    });
    expect(r.kind).toBe("ok");
    for (const [i, e] of t.applications.outbox.entries()) {
      await t.wiring.consumer.handle({ messageId: `0192f3a4-5b6c-7d8e-9f01-00000000091${i}`, type: e.type, payload: e.payload });
    }
    expect(await t.stores.all()).toHaveLength(0);
    expect(t.memberships.owners.size).toBe(0);
    expect(t.notifier.sent.map((n) => n.templateKey)).toEqual(["brand_application_rejected"]);
  });

  it("a high-risk global approval creates nothing until a different admin cosigns", async () => {
    const t = build();
    t.applications.seed(record({ assigneeId: ADMIN_A, brandKind: "global", country: "AE", highRiskCountry: true }));
    t.verification.setReport(APP, { checks: [], dualApprovalRequired: true, riskScore: null });
    await t.wiring.review.decide(meta(ADMIN_A), APP, { decision: "approve", reasonCode: "ok" });
    expect(t.applications.outbox).toHaveLength(0);
    expect(await t.stores.all()).toHaveLength(0);
    expect((await t.wiring.review.cosign(meta(ADMIN_A), APP, "again", true)).kind).toBe("cosign_same_admin");
    expect((await t.wiring.review.cosign(meta(ADMIN_B), APP, "second", false)).kind).toBe("elevation_required");
    expect((await t.wiring.review.cosign(meta(ADMIN_B), APP, "second", true)).kind).toBe("ok");
    const ev = t.applications.outbox.find((e) => e.type === "brand_application.approved");
    expect(ev).toBeDefined();
    if (ev !== undefined) await t.wiring.consumer.handle({ messageId: "0192f3a4-5b6c-7d8e-9f01-000000000903", type: ev.type, payload: ev.payload });
    expect(await t.stores.all()).toHaveLength(1);
  });

  it("reports which ports are still in-memory fallbacks", () => {
    const w = composeBrandOnboarding({ stores: new InMemoryStoreRepository([]), audit: new InMemoryAdminAudit(), clock });
    expect(w.fallbacks).toEqual(
      expect.arrayContaining(["sellers.BrandApplicationsAdminPort", "sellers.ProvisioningApplicationPort", "seller-auth.SellerMembershipsPort"]),
    );
  });
});

// ---------------------------------------------------------------------------------------------

type SDetail = NonNullable<Awaited<ReturnType<SellersAdminPort["get"]>>>;
const sdetail = (over: Partial<SDetail> = {}): SDetail => ({
  id: APP,
  status: "IN_REVIEW",
  version: 3,
  brandKind: "local",
  country: "EG",
  brandName: "Nile Basics",
  submittedAtMs: NOW - 5000,
  decisionDueAtMs: NOW + 5000,
  slaBreached: false,
  assigneeId: null,
  appealUsed: false,
  createdAtMs: NOW - 9000,
  applicantId: APPLICANT,
  legalName: "Nile Basics LLC",
  registration: { commercial_register_no: "CR1", tax_card_no: "TC1" },
  trademark: {},
  ownershipBasis: "brand_owner",
  websiteDomain: "nilebasics.example",
  domainVerification: null,
  contact: { phone_e164: "+201000000000" },
  signatory: { fullName: null, nationalIdLast4: null, dateOfBirth: null },
  duplicateNationalIdApplications: 0,
  documents: [
    { id: "d1", requirementCode: "commercial_register", contentType: "application/pdf", sizeBytes: 10, uploadStatus: "uploaded", scanStatus: "clean", reviewStatus: "unreviewed", reviewNotePublic: null, reviewNoteInternal: null, originalFilename: null },
  ],
  requestedItems: [],
  decision: null,
  storeId: null,
  history: [],
  ...over,
});

function fakeSellers(initial: SDetail) {
  const state = { d: initial, decided: [] as unknown[], marked: [] as unknown[] };
  const port: SellersAdminPort = {
    async list() {
      return { items: [state.d], next: null };
    },
    async get(id) {
      return id === state.d.id ? state.d : null;
    },
    async claim(i) {
      if (i.expectedVersion !== state.d.version) return { kind: "version_conflict", currentVersion: state.d.version };
      state.d = { ...state.d, assigneeId: i.adminId, version: state.d.version + 1 };
      return { kind: "ok", application: state.d };
    },
    async release(i) {
      state.d = { ...state.d, assigneeId: null, version: i.expectedVersion + 1 };
      return { kind: "ok", application: state.d };
    },
    async advanceChecks() {
      throw new Error("unused");
    },
    async runAutoChecks() {
      throw new Error("unused");
    },
    async applyDecision(i) {
      state.decided.push(i.input);
      state.d = { ...state.d, status: i.input.decision === "approved" ? "APPROVED" : "REJECTED", version: i.expectedVersion + 1 };
      return { kind: "ok", application: state.d };
    },
    async readDocumentUrl(i) {
      return i.documentId === "d1" ? { kind: "ok", url: "https://files.example.test/x", expiresAtMs: NOW + 900_000 } : { kind: "not_found" };
    },
    async markProvisioned(i) {
      state.marked.push(i);
      state.d = { ...state.d, storeId: i.storeId, version: i.expectedVersion + 1 };
      return { kind: "ok", application: state.d };
    },
  };
  return { state, port };
}

describe("SellersReviewAdapter over the sellers public admin port", () => {
  it("maps detail, claim, decision (sanctions evidence passes through), cosign overlay and provisioning write-back", async () => {
    const { state, port } = fakeSellers(sdetail());
    const overlay = new InMemoryBrandReviewOverlay();
    const a = new SellersReviewAdapter(port, overlay);

    const rec = await a.get(APP);
    expect(rec).toMatchObject({ id: APP, version: 3, status: "IN_REVIEW", applicantUserId: APPLICANT, brandDomain: "nilebasics.example", brandKind: "local" });
    expect(rec?.applicantPhoneHash).toMatch(/^[0-9a-f]{64}$/);

    const claimed = await a.claim(APP, ADMIN_A, 3, NOW);
    expect(claimed.kind).toBe("ok");
    expect((await a.claim(APP, ADMIN_A, 3, NOW)).kind).toBe("version_conflict");

    const cos = await a.requestCosign(APP, 4, ADMIN_A, NOW);
    expect(cos.kind).toBe("ok");
    expect((await a.get(APP))?.pendingCosign).toEqual({ firstApproverId: ADMIN_A, requestedAtMs: NOW });
    expect((await a.requestCosign(APP, 1, ADMIN_A, NOW)).kind).toBe("version_conflict");

    const done = await a.applyDecision(APP, 4, {
      decision: "approve", reasonCode: "ok", publicMessageAr: null, publicMessageEn: null, requestedItems: [], internalNote: null,
      reapplyAfterDays: null, slug: null, decidedBy: ADMIN_A, cosignedBy: ADMIN_B, sanctionsClear: true, atMs: NOW,
    });
    expect(done.kind).toBe("ok");
    expect(state.decided[0]).toMatchObject({ decision: "approved", sanctionsClear: true });
    expect((await a.get(APP))?.pendingCosign).toBeNull();

    const facts = await a.payloadFor(APP);
    expect(facts).toMatchObject({ applicant_seller_user_id: APPLICANT, brand_name: "Nile Basics", registration_no: "CR1", tax_card_no: "TC1", country: "EG" });
    await a.markProvisioned(APP, deterministicStoreId(APP));
    await a.markProvisioned(APP, deterministicStoreId(APP)); // idempotent: second call does not re-mark
    expect(state.marked).toHaveLength(1);
    await expect(a.markProvisioned(APP, "0192f3a4-5b6c-7d8e-9f01-0000000000ff")).rejects.toThrow();
  });

  it("a parked provisioning failure is visible to admins as PROVISIONING_FAILED and listable", async () => {
    const { port } = fakeSellers(sdetail({ status: "APPROVED" }));
    const a = new SellersReviewAdapter(port, new InMemoryBrandReviewOverlay());
    expect((await a.get(APP))?.status).toBe("APPROVED");
    await a.markProvisioningFailed(APP, "store_name_conflict");
    const rec = await a.get(APP);
    expect(rec).toMatchObject({ status: "PROVISIONING_FAILED", provisioningFailure: "store_name_conflict" });
    const parked = await a.list({ adminId: ADMIN_A, status: "PROVISIONING_FAILED" }, null, 10);
    expect(parked.items.map((r) => r.id)).toEqual([APP]);
    expect(await a.listFailed(10)).toEqual([APP]);
    await a.markProvisioned(APP, deterministicStoreId(APP));
    expect((await a.get(APP))?.provisioningFailure).toBeNull();
  });

  it("documents and read urls come from the sellers port", async () => {
    const { port } = fakeSellers(sdetail());
    const docs = new SellersDocumentAccess(port);
    expect(await docs.documents(APP)).toEqual([expect.objectContaining({ id: "d1", scanStatus: "clean", uploadStatus: "uploaded" })]);
    expect(await docs.createReadUrl(APP, "d1", 900_000, NOW, { adminId: ADMIN_A, reasonCode: "kyc_review" })).toMatchObject({ kind: "ok" });
    expect(await docs.createReadUrl(APP, "zz", 900_000, NOW, { adminId: ADMIN_A, reasonCode: "kyc_review" })).toEqual({ kind: "not_found" });
  });

  it("composition with a real sellers port derives review, documents and provisioning adapters", () => {
    const { port } = fakeSellers(sdetail());
    const w = composeBrandOnboarding({
      stores: new InMemoryStoreRepository([]),
      audit: new InMemoryAdminAudit(),
      clock,
      real: { sellers: port, overlay: new InMemoryBrandReviewOverlay() },
    });
    expect(w.fallbacks).not.toContain("sellers.BrandApplicationsAdminPort");
    expect(w.fallbacks).not.toContain("sellers.ProvisioningApplicationPort");
    expect(w.fallbacks).not.toContain("sellers.DocumentAccess");
  });
});

describe("auto checks after submit", () => {
  it("brand_application.submitted runs runAutoChecks once per message and still notifies", async () => {
    const { state, port } = fakeSellers(sdetail({ status: "SUBMITTED" }));
    const runs: unknown[] = [];
    port.runAutoChecks = async (i) => {
      runs.push(i);
      state.d = { ...state.d, status: "IN_REVIEW", version: i.expectedVersion + 2 };
      return { kind: "ok", application: state.d };
    };
    const notifier = new RecordingBrandNotifier();
    const w = composeBrandOnboarding({
      stores: new InMemoryStoreRepository([]),
      audit: new InMemoryAdminAudit(),
      clock,
      real: { sellers: port, overlay: new InMemoryBrandReviewOverlay(), notifier, inbox: new InMemoryInboxRunner() },
    });
    const msg = { messageId: "0192f3a4-5b6c-7d8e-9f01-000000000931", type: "brand_application.submitted", payload: { application_id: APP } };
    expect((await w.consumer.handle(msg)).kind).toBe("notified");
    expect((await w.consumer.handle(msg)).kind).toBe("duplicate");
    expect(runs).toEqual([{ id: APP, expectedVersion: 3 }]);
    expect(state.d.status).toBe("IN_REVIEW");
    expect(notifier.sent.map((n) => n.templateKey)).toEqual(["brand_application_received"]);
  });
});

describe("AuthSellerMemberships", () => {
  it("grants the applicant the owner role through the seller auth service and fails loudly otherwise", async () => {
    const calls: unknown[] = [];
    const ok = new AuthSellerMemberships({
      async grantStoreRole(i) {
        calls.push(i);
        return { kind: "ok", membership: { id: "m", sellerUserId: i.sellerUserId, storeId: i.storeId, role: i.role, grantedBy: null, createdAtMs: NOW } as never };
      },
    });
    await ok.grantOwner({ sellerUserId: APPLICANT, storeId: "s1" });
    expect(calls).toEqual([{ sellerUserId: APPLICANT, storeId: "s1", role: "owner", grantedBy: null }]);
    const bad = new AuthSellerMemberships({ async grantStoreRole() { return { kind: "seller_not_found" }; } });
    await expect(bad.grantOwner({ sellerUserId: APPLICANT, storeId: "s1" })).rejects.toThrow("seller_not_found");
  });
});
