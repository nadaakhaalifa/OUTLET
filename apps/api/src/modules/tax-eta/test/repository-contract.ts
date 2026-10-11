import { beforeEach, describe, expect, it } from "vitest";
import { applyExemptionChange, type TaxCategory } from "../domain/bridge";
import type { SignedDocumentStore, TaxConfigRepository, TaxDocumentRepository } from "../domain/ports";
import { STORE_A, STORE_B, T0, U, consumerParty, invoiceDoc, queued, receiptDoc, stored } from "./fixtures";

export interface TaxRepoContext {
  readonly config: TaxConfigRepository;
  readonly documents: TaxDocumentRepository;
  readonly signed: SignedDocumentStore;
  ensureUser(userId: string): Promise<void>;
}

const EX = { reasonAr: "إعفاء بقرار", reasonEn: "Exempt by decision", legalBasis: "Decision 1", effectiveFromMs: T0, effectiveToMs: null };

/** Behaviour every tax repository must have. Run against in-memory and Kysely/PGlite. */
export function describeTaxRepositoryContract(name: string, make: () => Promise<TaxRepoContext>): void {
  describe(`tax repository contract: ${name}`, () => {
    let c: TaxRepoContext;
    beforeEach(async () => {
      c = await make();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
    });

    it("seeds the 14% categories", async () => {
      const list = await c.config.listCategories();
      expect(list.length).toBeGreaterThanOrEqual(5);
      expect(list.every((x) => x.rateBps === 1_400n && x.exemption === null && x.version === 0)).toBe(true);
      expect(await c.config.getCategory("nope")).toBeNull();
    });

    it("saves an exemption with its audit row atomically and rejects stale versions", async () => {
      const cat = (await c.config.getCategory("shipping")) as TaxCategory;
      const { category, audit } = applyExemptionChange(cat, { kind: "set", exemption: EX, reason: "ruling" }, U(9), T0);
      expect(await c.config.saveCategoryWithAudit(category, audit)).toBe("ok");
      const back = await c.config.getCategory("shipping");
      expect(back?.exemption).toEqual(EX);
      expect(back?.version).toBe(1);
      expect(await c.config.saveCategoryWithAudit(category, audit)).toBe("conflict");
      const log = await c.config.listAudit("shipping", 10);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ action: "exemption_set", actorId: U(9), versionAfter: 1, reason: "ruling" });
      expect(await c.config.listAudit("standard", 10)).toHaveLength(0);
      const ghost = { ...cat, code: "ghost", version: 1 };
      expect(await c.config.saveCategoryWithAudit(ghost, { ...audit, categoryCode: "ghost" })).toBe("not_found");
    });

    it("creates once, round-trips exact bigint amounts and is idempotent on the source", async () => {
      const doc = invoiceDoc(1, STORE_A, 9_007_199_254_740_993n);
      const s = stored(1, doc);
      const out = await c.documents.createWithSubmission(s, queued(s));
      expect(out.kind).toBe("created");
      const dup = await c.documents.createWithSubmission({ ...s, id: U(7777) }, queued({ ...s, id: U(7777) }));
      expect(dup.kind).toBe("duplicate");
      expect(dup.value.stored.id).toBe(s.id);
      const back = await c.documents.findById(s.id);
      expect(back?.stored.document.totals.net.amount).toBe(9_007_199_254_740_993n);
      expect(back?.stored.document.lines[0]?.descriptionAr).toBe("عمولة البيع");
      expect(back?.submission.state).toBe("QUEUED");
      expect((await c.documents.findByInternalId(doc.internalId))?.stored.id).toBe(s.id);
      expect(await c.documents.findById(U(1))).toBeNull();
    });

    it("updates a submission only with the expected version", async () => {
      const s = stored(2, invoiceDoc(2));
      await c.documents.createWithSubmission(s, queued(s));
      const sent = { ...queued(s), state: "SUBMITTED" as const, attempts: 1, lastSubmittedAtMs: T0 + 5, version: 1 };
      expect(await c.documents.updateSubmission(sent, 0)).toBe(true);
      expect(await c.documents.updateSubmission(sent, 0)).toBe(false);
      const back = await c.documents.findById(s.id);
      expect(back?.submission).toMatchObject({ state: "SUBMITTED", attempts: 1, version: 1, lastSubmittedAtMs: T0 + 5 });
      const done = { ...sent, state: "ACCEPTED" as const, etaUuid: "u-1", signedDocumentRef: "ref", decidedAtMs: T0 + 9, rejectionReasons: ["a"], version: 2 };
      expect(await c.documents.updateSubmission(done, 1)).toBe(true);
      const fin = await c.documents.findById(s.id);
      expect(fin?.submission).toMatchObject({ state: "ACCEPTED", etaUuid: "u-1", decidedAtMs: T0 + 9, rejectionReasons: ["a"] });
    });

    it("lists due, awaiting-status and window queries", async () => {
      const a = stored(3, invoiceDoc(3));
      const b = stored(4, invoiceDoc(4));
      const r = stored(5, receiptDoc(5));
      await c.documents.createWithSubmission(a, queued(a, { nextAttemptAtMs: T0 + 10 }));
      await c.documents.createWithSubmission(b, queued(b, { state: "SUBMITTED", attempts: 1, lastSubmittedAtMs: T0 + 100, version: 1 }));
      await c.documents.createWithSubmission(r, queued(r, { state: "RETRY", attempts: 1, nextAttemptAtMs: T0 + 5000 }));
      expect((await c.documents.listDue(T0 + 10, 10)).map((d) => d.stored.id)).toEqual([a.id]);
      expect((await c.documents.listDue(T0 + 6000, 10)).map((d) => d.stored.id)).toEqual([a.id, r.id]);
      expect((await c.documents.listAwaitingStatus(T0 + 99, 10))).toHaveLength(0);
      expect((await c.documents.listAwaitingStatus(T0 + 100, 10)).map((d) => d.stored.id)).toEqual([b.id]);
      const win = await c.documents.listIssuedBetween(T0 + 3000, T0 + 5000);
      expect(win.map((d) => d.stored.id)).toEqual([a.id, b.id]);
    });

    it("scopes store lists to the caller's stores and kind, newest first, with a cursor", async () => {
      for (let i = 10; i < 14; i += 1) {
        const s = stored(i, invoiceDoc(i, STORE_A));
        await c.documents.createWithSubmission(s, queued(s));
      }
      const other = stored(20, invoiceDoc(20, STORE_B), { storeId: STORE_B });
      await c.documents.createWithSubmission(other, queued(other));
      const rcpt = stored(21, receiptDoc(21, U(2)), { userId: U(2) });
      await c.documents.createWithSubmission(rcpt, queued(rcpt));

      const p1 = await c.documents.listForStores([STORE_A], ["seller_einvoice"], null, 3);
      if (p1 === "invalid_cursor") throw new Error("cursor");
      expect(p1.items).toHaveLength(3);
      expect(p1.items.every((d) => d.stored.storeId === STORE_A)).toBe(true);
      expect(p1.items.map((d) => d.stored.document.sourceRef)).toEqual(["settle-13", "settle-12", "settle-11"]);
      expect(p1.nextCursor).not.toBeNull();
      const p2 = await c.documents.listForStores([STORE_A], ["seller_einvoice"], p1.nextCursor, 3);
      if (p2 === "invalid_cursor") throw new Error("cursor");
      expect(p2.items.map((d) => d.stored.document.sourceRef)).toEqual(["settle-10"]);
      expect(p2.nextCursor).toBeNull();
      expect(await c.documents.listForStores([STORE_A], ["seller_einvoice"], "garbage!", 3)).toBe("invalid_cursor");

      const all = await c.documents.listAll({ kind: "shopper_ereceipt" }, null, 10);
      if (all === "invalid_cursor") throw new Error("cursor");
      expect(all.items.map((d) => d.stored.userId)).toEqual([U(2)]);
      void consumerParty;
    });

    it("stores signed documents with a content hash", async () => {
      const s = stored(30, invoiceDoc(30));
      await c.documents.createWithSubmission(s, queued(s));
      const put = await c.signed.put(s.document.internalId, { contentType: "application/json", body: '{"a":"ب"}' });
      expect(put.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await c.signed.get(put.ref)).toMatchObject({ contentType: "application/json", body: '{"a":"ب"}', sha256: put.sha256 });
      expect(await c.signed.get("missing")).toBeNull();
    });
  });
}
