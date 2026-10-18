import { describe, expect, it } from "vitest";
import type { BrandApplicationRepository } from "../domain/ports";
import { ADMIN, APPLICANT_A, APPLICANT_B, T0, U, appRow, docRow, hist } from "./fixtures";

export interface RepoHarness {
  readonly repo: BrandApplicationRepository;
  /** Event types written by the repository, in order. */
  outboxTypes(): Promise<string[]>;
  ensureUser?(id: string): Promise<void>;
}

const A = { kind: "applicant", applicantId: APPLICANT_A } as const;
const B = { kind: "applicant", applicantId: APPLICANT_B } as const;
const SYS = { kind: "system" } as const;
const ev = (n: number, type: string, aggregateId: string) => ({ id: U(800 + n), type, aggregateId, occurredAtMs: T0, payload: { application_id: aggregateId } });

/** Shared by the in-memory and the Kysely/PGlite adapters so they cannot drift. */
export function describeSellersRepositoryContract(name: string, fresh: () => Promise<RepoHarness>): void {
  describe(`BrandApplicationRepository contract: ${name}`, () => {
    it("inserts and reads back for the owner only (others get null)", async () => {
      const h = await fresh();
      const r = appRow(1);
      expect(await h.repo.insert(r, hist(1, "DRAFT", "DRAFT"), [])).toBe("created");
      expect((await h.repo.get(r.id, A))?.app).toMatchObject({ id: r.id, status: "DRAFT", brandName: "Brand 1", version: 0 });
      expect(await h.repo.get(r.id, B)).toBeNull();
      expect((await h.repo.get(r.id, SYS))?.app.id).toBe(r.id);
      expect(await h.repo.get(U(99999), A)).toBeNull();
    });

    it("allows one active application per applicant and normalised name, but not after withdrawal", async () => {
      const h = await fresh();
      const a = appRow(1, { brandNameNorm: "zara" });
      await h.repo.insert(a, hist(1, "DRAFT", "DRAFT"), []);
      expect(await h.repo.insert(appRow(2, { brandNameNorm: "zara" }), hist(2, "DRAFT", "DRAFT"), [])).toBe("duplicate_active");
      expect(await h.repo.insert(appRow(3, { brandNameNorm: "zara", applicantId: APPLICANT_B }), hist(3, "DRAFT", "DRAFT"), [])).toBe("created");
      const r = await h.repo.commit({ scope: A, expectedVersion: 0, app: { ...a, status: "WITHDRAWN", version: 1 }, documentsUpsert: [], documentsDelete: [], history: hist(4, "DRAFT", "WITHDRAWN"), events: [] });
      expect(r).toBe("ok");
      expect(await h.repo.insert(appRow(5, { brandNameNorm: "zara" }), hist(5, "DRAFT", "DRAFT"), [])).toBe("created");
    });

    it("commits with optimistic version CAS, documents, history and outbox in one step", async () => {
      const h = await fresh();
      const a = appRow(1);
      await h.repo.insert(a, hist(1, "DRAFT", "DRAFT"), []);
      const d = docRow(a.id, APPLICANT_A, 1);
      const next = { ...a, version: 1, status: "SUBMITTED" as const, submittedAtMs: T0 };
      expect(await h.repo.commit({ scope: A, expectedVersion: 0, app: next, documentsUpsert: [d], documentsDelete: [], history: hist(2, "DRAFT", "SUBMITTED"), events: [ev(1, "brand_application.submitted", a.id)] })).toBe("ok");
      // stale writer
      expect(await h.repo.commit({ scope: A, expectedVersion: 0, app: { ...next, version: 1 }, documentsUpsert: [], documentsDelete: [], history: null, events: [ev(2, "brand_application.submitted", a.id)] })).toBe("conflict");
      // another applicant cannot write
      expect(await h.repo.commit({ scope: B, expectedVersion: 1, app: { ...next, version: 2 }, documentsUpsert: [], documentsDelete: [], history: null, events: [] })).toBe("not_found");
      const got = await h.repo.get(a.id, A);
      expect(got?.app.status).toBe("SUBMITTED");
      expect(got?.documents.map((x) => x.id)).toEqual([d.id]);
      expect((await h.repo.history(a.id)).map((x) => x.toStatus)).toEqual(["DRAFT", "SUBMITTED"]);
      expect(await h.outboxTypes()).toEqual(["brand_application.submitted"]);
      // upsert updates in place, delete removes
      await h.repo.commit({ scope: A, expectedVersion: 1, app: { ...next, version: 2 }, documentsUpsert: [{ ...d, uploadStatus: "uploaded", scanStatus: "clean", uploadedAtMs: T0 }], documentsDelete: [], history: null, events: [] });
      expect((await h.repo.get(a.id, A))?.documents[0]).toMatchObject({ uploadStatus: "uploaded", scanStatus: "clean" });
      await h.repo.commit({ scope: A, expectedVersion: 2, app: { ...next, version: 3 }, documentsUpsert: [], documentsDelete: [d.id], history: null, events: [] });
      expect((await h.repo.get(a.id, A))?.documents).toEqual([]);
    });

    it("round-trips decision, requested items, domain verification and bytes", async () => {
      const h = await fresh();
      const a = appRow(1, {
        piiEnc: new Uint8Array([1, 2, 3]), nationalIdBlind: new Uint8Array([9, 9]), nationalIdEnc: new Uint8Array([4]),
        requestedItems: [{ code: "tax_card", kind: "document", messageAr: "م", messageEn: "m", satisfied: false }],
        decision: { decision: "needs_info", reasonCode: "incomplete_information", messageAr: "أ", messageEn: "e", decidedAtMs: T0, reapplyAfterMs: null, appealAllowed: false },
        domainVerification: { method: "dns_txt", domain: "zara.eg", status: "pending", txtRecordName: "_x.zara.eg", txtRecordValue: "v", expiresAtMs: T0 + 1000, verifiedAtMs: null },
        acknowledgements: { seller_agreement_version: "1", price_monitoring_consent: true },
        socialHandles: { instagram: "zara" },
      });
      await h.repo.insert(a, hist(1, "DRAFT", "DRAFT"), []);
      const got = (await h.repo.get(a.id, A))?.app;
      expect(Array.from(got?.piiEnc ?? [])).toEqual([1, 2, 3]);
      expect(got?.requestedItems).toEqual(a.requestedItems);
      expect(got?.decision).toEqual(a.decision);
      expect(got?.domainVerification).toMatchObject({ method: "dns_txt", domain: "zara.eg", status: "pending", verifiedAtMs: null });
      expect(got?.acknowledgements).toEqual(a.acknowledgements);
      expect(await h.repo.countOtherByNationalId(new Uint8Array([9, 9]), U(99999))).toBe(1);
      expect(await h.repo.countOtherByNationalId(new Uint8Array([9, 9]), a.id)).toBe(0);
    });

    it("pages an applicant's applications newest first with a keyset cursor and never leaks others", async () => {
      const h = await fresh();
      for (let n = 1; n <= 5; n += 1) await h.repo.insert(appRow(n), hist(n, "DRAFT", "DRAFT"), []);
      await h.repo.insert(appRow(6, { applicantId: APPLICANT_B }), hist(6, "DRAFT", "DRAFT"), []);
      const p1 = await h.repo.listForApplicant(APPLICANT_A, null, 2);
      expect(p1.items.map((x) => x.app.brandName)).toEqual(["Brand 5", "Brand 4"]);
      expect(p1.next).not.toBeNull();
      const p2 = await h.repo.listForApplicant(APPLICANT_A, p1.next, 2);
      expect(p2.items.map((x) => x.app.brandName)).toEqual(["Brand 3", "Brand 2"]);
      const p3 = await h.repo.listForApplicant(APPLICANT_A, p2.next, 2);
      expect(p3.items.map((x) => x.app.brandName)).toEqual(["Brand 1"]);
      expect(p3.next).toBeNull();
    });

    it("finds the latest rejection and counts recent documents", async () => {
      const h = await fresh();
      const a = appRow(1, { status: "REJECTED", rejectedAtMs: T0 + 5000, brandNameNorm: "gucci" });
      await h.repo.insert(a, hist(1, "DRAFT", "DRAFT"), []);
      expect(await h.repo.lastRejectedAtMs(APPLICANT_A, "gucci")).toBe(T0 + 5000);
      expect(await h.repo.lastRejectedAtMs(APPLICANT_B, "gucci")).toBeNull();
      expect(await h.repo.lastRejectedAtMs(APPLICANT_A, "other")).toBeNull();
      const b = appRow(2);
      await h.repo.insert(b, hist(2, "DRAFT", "DRAFT"), []);
      await h.repo.commit({ scope: A, expectedVersion: 0, app: { ...b, version: 1 }, documentsUpsert: [docRow(b.id, APPLICANT_A, 1, { createdAtMs: T0 }), docRow(b.id, APPLICANT_A, 2, { createdAtMs: T0 + 10 })], documentsDelete: [], history: null, events: [] });
      expect(await h.repo.countDocumentsSince(b.id, T0 + 5)).toBe(1);
      expect(await h.repo.countDocumentsSince(b.id, T0 - 1)).toBe(2);
    });

    it("lists the review queue with filters and excludes drafts", async () => {
      const h = await fresh();
      const rows = [
        appRow(1, { status: "IN_REVIEW", submittedAtMs: T0, decisionDueAtMs: T0 + 100 }),
        appRow(2, { status: "SUBMITTED", brandKind: "global", country: "FR", brandNameNorm: "b2", applicantId: APPLICANT_B, decisionDueAtMs: T0 + 10_000 }),
        appRow(3, { status: "DRAFT", brandNameNorm: "b3" }),
        appRow(4, { status: "IN_REVIEW", assigneeId: ADMIN, brandNameNorm: "b4", decisionDueAtMs: T0 + 100 }),
      ];
      for (const [i, r] of rows.entries()) expect(await h.repo.insert(r, hist(10 + i, "DRAFT", "DRAFT"), [])).toBe("created");
      const all = await h.repo.listForReview({ after: null, limit: 10 });
      expect(all.items.map((x) => x.app.id).sort()).toEqual([rows[0]!.id, rows[1]!.id, rows[3]!.id].sort());
      expect((await h.repo.listForReview({ status: "SUBMITTED", after: null, limit: 10 })).items).toHaveLength(1);
      expect((await h.repo.listForReview({ kind: "global", country: "FR", after: null, limit: 10 })).items).toHaveLength(1);
      expect((await h.repo.listForReview({ assigneeId: "unassigned", after: null, limit: 10 })).items).toHaveLength(2);
      expect((await h.repo.listForReview({ assigneeId: ADMIN, after: null, limit: 10 })).items).toHaveLength(1);
      expect((await h.repo.listForReview({ slaBreachedAtMs: T0 + 1000, after: null, limit: 10 })).items).toHaveLength(2);
      const page = await h.repo.listForReview({ after: null, limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.next).not.toBeNull();
    });
  });
}
