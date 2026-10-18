import { afterAll, describe, expect, it } from "vitest";
import type { ClaimView } from "../domain/bridge";
import type { BrandVerificationStore, DomainVerificationRecord, Effects, TrademarkLookupRecord } from "../domain/ports";
import { InMemoryBrandVerificationStore } from "../adapters/in-memory";
import { KyselyBrandVerificationStore, type BrandVerificationDb } from "../adapters/kysely-store";
import { U, fakeIds } from "./fixtures";
import { createBrandVerificationDatabase } from "./pglite-db";

interface Kit {
  readonly store: BrandVerificationStore;
  outboxTypes(): Promise<string[]>;
  historyCount(): Promise<number>;
}

const fx = (app: string, type: string): Effects => ({
  outbox: [{ aggregateId: app, eventType: type, payload: { application_id: app } }],
  history: [{ applicationId: app, actorId: null, action: "test.action", refId: null }],
});
const dv = (n: number, over: Partial<DomainVerificationRecord> = {}): DomainVerificationRecord => ({
  applicationId: U(n), applicantId: U(500 + n), domain: "brand.com", method: "dns_txt", status: "pending", nonce: "n".repeat(32), emailLocal: null,
  emailCodeHash: null, attempts: 0, expiresAtMs: 2_000_000_000_000, verifiedAtMs: null, version: 0, createdAtMs: 1_700_000_000_000, updatedAtMs: 1_700_000_000_000, ...over,
});
const claim = (n: number, over: Partial<ClaimView> = {}): ClaimView => ({
  applicationId: U(n), applicantId: U(500 + n), kind: "global", country: "FR", brandNameNorm: "lumen", domain: null, trademarkKey: null,
  domainVerifiedAtMs: null, trademarkMatchedAtMs: null, submittedAtMs: 1_700_000_000_000, ...over,
});

function contract(name: string, make: () => Promise<Kit>): void {
  describe(`BrandVerificationStore contract: ${name}`, () => {
    it("inserts a domain verification with effects, then compare-and-sets on version", async () => {
      const k = await make();
      expect(await k.store.saveDomainVerification(dv(1), null, fx(U(1), "brand_domain.verification_started"))).toBe("saved");
      expect(await k.store.saveDomainVerification(dv(1), null, fx(U(1), "x.dup"))).toBe("version_conflict");
      const verified = dv(1, { status: "verified", verifiedAtMs: 1_700_000_100_000, version: 1 });
      expect(await k.store.saveDomainVerification(verified, 0, fx(U(1), "brand_domain.verified"))).toBe("saved");
      expect(await k.store.saveDomainVerification({ ...verified, version: 2 }, 0, fx(U(1), "x.stale"))).toBe("version_conflict");
      expect(await k.store.getDomainVerification(U(1))).toEqual(verified);
      expect(await k.store.getDomainVerification(U(2))).toBeNull();
      expect(await k.outboxTypes()).toEqual(["brand_domain.verification_started", "brand_domain.verified"]);
      expect(await k.historyCount()).toBe(2);
    });

    it("round-trips an email challenge", async () => {
      const k = await make();
      const rec = dv(3, { method: "email", emailLocal: "info", emailCodeHash: "a".repeat(64), attempts: 2 });
      await k.store.saveDomainVerification(rec, null, { outbox: [], history: [] });
      expect(await k.store.getDomainVerification(U(3))).toEqual(rec);
    });

    it("upserts claims and finds candidates by country, domain or trademark, excluding itself", async () => {
      const k = await make();
      await k.store.upsertClaim(claim(1));
      await k.store.upsertClaim(claim(2, { country: "DE", domain: "x.com" }));
      await k.store.upsertClaim(claim(3, { country: "IT", trademarkKey: "EUIPO:1" }));
      await k.store.upsertClaim(claim(4, { country: "ES" }));
      await k.store.upsertClaim(claim(1, { domain: "lumen.com", domainVerifiedAtMs: 1_700_000_500_000 }));
      expect(await k.store.getClaim(U(1))).toEqual(claim(1, { domain: "lumen.com", domainVerifiedAtMs: 1_700_000_500_000 }));
      const found = await k.store.findClaimCandidates({ exceptApplicationId: U(1), country: "FR", domain: "x.com", trademarkKey: "EUIPO:1" });
      expect(found.map((c) => c.applicationId)).toEqual([U(2), U(3)]);
      expect(await k.store.findClaimCandidates({ exceptApplicationId: U(2), country: "ZZ", domain: null, trademarkKey: null })).toEqual([]);
    });

    it("opens conflicts idempotently on the application pair, merges reasons, resolves once", async () => {
      const k = await make();
      const a = await k.store.openConflict({ id: U(900), applicationIds: [U(2), U(1)], reasons: ["same_name"], createdAtMs: 1_700_000_000_000 }, fx(U(900), "brand_claim_conflict.opened"));
      expect(a.created).toBe(true);
      const b = await k.store.openConflict({ id: U(901), applicationIds: [U(1), U(2)], reasons: ["same_domain"], createdAtMs: 1_700_000_001_000 }, fx(U(901), "brand_claim_conflict.opened"));
      expect(b.created).toBe(false);
      expect(b.conflict.id).toBe(U(900));
      expect(b.conflict.reasons).toEqual(["same_domain", "same_name"]);
      expect((await k.store.listConflictsFor(U(2))).map((c) => c.id)).toEqual([U(900)]);
      expect(await k.store.listConflictsFor(U(9))).toEqual([]);
      const r = await k.store.resolveConflict({ id: U(900), outcome: "keep_first", winnerApplicationId: U(1), resolvedBy: U(77), atMs: 1_700_000_002_000 }, fx(U(900), "brand_claim_conflict.resolved"));
      expect(r.kind).toBe("resolved");
      const again = await k.store.resolveConflict({ id: U(900), outcome: "reject_all", winnerApplicationId: null, resolvedBy: U(78), atMs: 1_700_000_003_000 }, fx(U(900), "x.never"));
      expect(again.kind).toBe("already_resolved");
      expect(again.kind === "already_resolved" && again.conflict.outcome).toBe("keep_first");
      expect((await k.store.resolveConflict({ id: U(999), outcome: "both_valid", winnerApplicationId: null, resolvedBy: U(77), atMs: 1 }, fx(U(999), "x.never"))).kind).toBe("not_found");
      expect(await k.outboxTypes()).toEqual(["brand_claim_conflict.opened", "brand_claim_conflict.resolved"]);
    });

    it("stores trademark evidence, screenings and reports, newest first for latest", async () => {
      const k = await make();
      const tm: TrademarkLookupRecord = {
        id: U(300), applicationId: U(1), source: "registry", office: "EUIPO", registerNumber: "018123456", found: true, ownerName: "Lumen Atelier SAS",
        markText: "LUMEN", classes: [18, 25], status: "registered", registeredOn: "2020-01-02", expiresOn: "2030-01-02", ownerScore: 100, ownerBand: "match",
        recordedBy: null, retrievedAtMs: 1_700_000_000_000, createdAtMs: 1_700_000_000_000,
      };
      await k.store.insertTrademarkLookup(tm, fx(U(1), "brand_trademark.lookup_recorded"));
      expect(await k.store.listTrademarkLookups(U(1))).toEqual([tm]);
      expect(await k.store.listTrademarkLookups(U(2))).toEqual([]);
      await k.store.insertScreening({ id: U(310), applicationId: U(1), outcome: "clear", matchedListIds: [], listVersion: "v1", screenedAtMs: 1_700_000_000_000 });
      await k.store.insertScreening({ id: U(311), applicationId: U(1), outcome: "warn", matchedListIds: ["SYN-1"], listVersion: "v2", screenedAtMs: 1_700_000_001_000 });
      expect((await k.store.latestScreening(U(1)))?.id).toBe(U(311));
      expect(await k.store.latestScreening(U(2))).toBeNull();
      const report = { ruleVersion: 1 as const, applicationId: U(1), ranAtMs: 5, checks: [], contributions: [], risk: "low" as const, reasons: [], dualApprovalRequired: false, forceManualTrademark: false };
      await k.store.insertReport({ id: U(320), applicationId: U(1), report, createdAtMs: 1_700_000_000_000 }, fx(U(1), "brand_verification.checks_completed"));
      expect((await k.store.latestReport(U(1)))?.report).toEqual(report);
      expect(await k.store.latestReport(U(2))).toBeNull();
    });
  });
}

const open: BrandVerificationDb[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

contract("in-memory", async () => {
  const store = new InMemoryBrandVerificationStore();
  return { store, outboxTypes: async () => store.outbox.map((e) => e.eventType), historyCount: async () => store.history.length };
});

contract("kysely/pglite", async () => {
  const { pg, db } = await createBrandVerificationDatabase();
  open.push(db);
  return {
    store: new KyselyBrandVerificationStore(db, fakeIds()),
    outboxTypes: async () => (await pg.query<{ t: string }>(`select event_type as t from outbox_events order by occurred_at, id`)).rows.map((r) => r.t),
    historyCount: async () => Number((await pg.query<{ n: string }>(`select count(*)::text as n from bv_history`)).rows[0]?.n),
  };
});

describe("kysely specifics", () => {
  it("rolls the state change back when an effect is rejected by the database", async () => {
    const { db } = await createBrandVerificationDatabase();
    open.push(db);
    const store = new KyselyBrandVerificationStore(db, fakeIds());
    await expect(
      store.saveDomainVerification(dv(1), null, { outbox: [{ aggregateId: U(1), eventType: "NOT A VALID EVENT", payload: {} }], history: [] }),
    ).rejects.toThrow();
    expect(await store.getDomainVerification(U(1))).toBeNull();
  });
});
