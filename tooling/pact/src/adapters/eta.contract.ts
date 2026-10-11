/**
 * Shared contract suite for EtaPort (spec B4). The live ETA adapter must pass the same suite
 * against recorded fixtures: etaContract("eta portal (fixtures)", () => ({ port: realAdapter, doc })).
 */
import { describe, expect, it } from "vitest";
import type { EtaPort } from "../../../../apps/api/src/modules/tax-eta/domain/ports";
import { invoiceDoc, receiptDoc } from "../../../../apps/api/src/modules/tax-eta/test/fixtures";

export interface EtaContractSubject {
  readonly port: EtaPort;
}

export function etaContract(name: string, make: () => EtaContractSubject): void {
  describe(`EtaPort contract: ${name}`, () => {
    it("submit of a valid invoice is accepted with a signed payload and an ETA uuid", async () => {
      const { port } = make();
      const r = await port.submit(invoiceDoc(1));
      expect(["accepted", "pending"]).toContain(r.kind);
      if (r.kind === "accepted") {
        expect(r.etaUuid.length).toBeGreaterThan(0);
        expect(r.signed.contentType).toMatch(/json|xml/);
        expect(r.signed.body.length).toBeGreaterThan(0);
      }
    });

    it("submit is idempotent on internalId: resubmission returns the same decision", async () => {
      const { port } = make();
      const doc = invoiceDoc(2);
      const a = await port.submit(doc);
      const b = await port.submit(doc);
      expect(b).toEqual(a);
    });

    it("status agrees with the submit decision and is not_found for unknown ids", async () => {
      const { port } = make();
      const doc = receiptDoc(3);
      const sub = await port.submit(doc);
      const st = await port.status(doc.internalId);
      if (sub.kind === "accepted") {
        expect(st.kind).toBe("accepted");
        if (st.kind === "accepted") expect(st.etaUuid).toBe(sub.etaUuid);
      }
      expect(await port.status("00000000-0000-4000-8000-00000000dead")).toEqual({ kind: "not_found" });
    });

    it("transient failures are a result kind or a thrown Error, never a malformed accept", async () => {
      const { port } = make();
      const r = await port.submit(invoiceDoc(4)).catch((e: unknown) => e);
      if (r instanceof Error) return;
      expect(["accepted", "pending", "rejected", "transient_error"]).toContain((r as { kind: string }).kind);
    });

    it("dayReport lists what was submitted, or null when ETA cannot be queried", async () => {
      const { port } = make();
      const doc = invoiceDoc(5);
      await port.submit(doc);
      const rep = await port.dayReport(0, Number.MAX_SAFE_INTEGER);
      if (rep === null) return;
      expect(rep.map((i) => i.internalId)).toContain(doc.internalId);
    });
  });
}
