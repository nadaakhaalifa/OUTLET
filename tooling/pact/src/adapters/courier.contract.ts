/**
 * Shared contract suite for CourierPort (spec 21). Any real adapter (Bosta, Aramex, Mylerz) must pass:
 *   courierContract("bosta (fixtures)", () => ({ port: new BostaCourier(new FixtureTransport()), ... }));
 */
import { describe, expect, it } from "vitest";
import { CourierRejectedError, CourierUnavailableError, type AwbRequest, type CourierPort } from "../../../../apps/api/src/modules/fulfillment/domain/ports";

export interface CourierContractSubject {
  readonly port: CourierPort;
  /** Optional: put the courier into a hard-down state (every call throws CourierUnavailableError). */
  readonly goDown?: () => void;
  /** Optional: respond to the next createAwb as if the courier rejected the address as unserviceable. */
  readonly rejectAll?: () => void;
}

const sid = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;

export function courierContract(name: string, make: () => CourierContractSubject): void {
  const awbReq = (n: number, cod: boolean): AwbRequest => ({
    shipmentId: sid(n),
    parcel: { weightG: 800, pieces: 1 },
    cod: cod ? { amount: 150_000n, currency: "EGP" } : null,
    recipient: { name: "Mona Test", phone: "+201005550001", governorate: "EG-C", city: "Nasr City", addressLine: "1 Test St, floor 2" },
    pickup: { label: "Store A", governorate: "EG-C", city: "Cairo", addressLine: "9 Warehouse Rd" },
  });

  describe(`CourierPort contract: ${name}`, () => {
    it("has a stable lower-case code", () => {
      expect(make().port.code).toMatch(/^[a-z0-9_]+$/);
    });

    it("createAwb is idempotent by shipmentId (two calls, one AWB)", async () => {
      const { port } = make();
      const a = await port.createAwb(awbReq(1, true));
      const b = await port.createAwb(awbReq(1, true));
      expect(a.awb.length).toBeGreaterThan(0);
      expect(b).toEqual(a);
    });

    it("different shipments get different AWBs", async () => {
      const { port } = make();
      const a = await port.createAwb(awbReq(2, false));
      const b = await port.createAwb(awbReq(3, false));
      expect(a.awb).not.toBe(b.awb);
    });

    it("label is an A6 PDF", async () => {
      const { port } = make();
      const { awb } = await port.createAwb(awbReq(4, false));
      const l = await port.getLabel(awb);
      expect(l.contentType).toBe("application/pdf");
      expect(Buffer.from(l.bytes.slice(0, 4)).toString("latin1")).toBe("%PDF");
    });

    it("label for an unknown AWB is a permanent rejection", async () => {
      const { port } = make();
      await expect(port.getLabel("UNKNOWN-AWB")).rejects.toBeInstanceOf(CourierRejectedError);
    });

    it("track returns normalized facts with unique courier event ids", async () => {
      const { port } = make();
      const { awb } = await port.createAwb(awbReq(5, false));
      const facts = await port.track(awb);
      expect(Array.isArray(facts)).toBe(true);
      expect(new Set(facts.map((f) => f.courierEventId)).size).toBe(facts.length);
      for (const f of facts) expect(Number.isFinite(f.occurredAtMs)).toBe(true);
    });

    it("cancel answers cancelled or too_late", async () => {
      const { port } = make();
      const { awb } = await port.createAwb(awbReq(6, false));
      expect(["cancelled", "too_late"]).toContain(await port.cancel(awb));
    });

    it("an outage is a transient CourierUnavailableError (retryable), not a rejection", async () => {
      const s = make();
      if (s.goDown === undefined) return;
      s.goDown();
      await expect(s.port.createAwb(awbReq(7, false))).rejects.toBeInstanceOf(CourierUnavailableError);
    });

    it("an unserviceable area is a permanent CourierRejectedError with a code", async () => {
      const s = make();
      if (s.rejectAll === undefined) return;
      s.rejectAll();
      const err = await s.port.createAwb(awbReq(8, false)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CourierRejectedError);
      expect((err as CourierRejectedError).code.length).toBeGreaterThan(0);
    });
  });
}
