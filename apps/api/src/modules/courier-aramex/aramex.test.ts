import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/env";
import { CourierRejectedError, CourierUnavailableError, type AwbRequest } from "../fulfillment";
import { ARAMEX_PATHS, AramexCourier, AramexHubOutbound, CourierAramexModule, FakeAramexTransport, MissingAramexPortsError, StaticAramexCredentials, gramsToKg, mapAramexUpdateCode, piastresToEgp } from "./index";

const req = (over: Partial<AwbRequest> = {}): AwbRequest => ({
  shipmentId: "0192f3a4-5b6c-7d8e-9f01-000000000001",
  parcel: { weightG: 1_234, pieces: 2 },
  cod: { amount: 150_050n, currency: "EGP" },
  recipient: { name: "Mona Test", phone: "+201000000000", governorate: "Giza", city: "Dokki", addressLine: "1 Test St" },
  pickup: { label: "Cairo hub", governorate: "Cairo", city: "Nasr City", addressLine: "Hub 1" },
  ...over,
});

let t: FakeAramexTransport;
let c: AramexCourier;
beforeEach(() => {
  t = new FakeAramexTransport();
  c = new AramexCourier(t, new StaticAramexCredentials());
});

describe("CourierPort behaviour", () => {
  it("createAwb is idempotent by shipment id, including after a lost response", async () => {
    const a = await c.createAwb(req());
    const b = await c.createAwb(req());
    expect(b.awb).toBe(a.awb);
    expect(a.awb).toMatch(/^ARX[0-9A-F]{9}$/);
    t.timeoutAfterCreate = true;
    await expect(c.createAwb(req({ shipmentId: "0192f3a4-5b6c-7d8e-9f01-000000000002" }))).rejects.toBeInstanceOf(CourierUnavailableError);
    const retry = await c.createAwb(req({ shipmentId: "0192f3a4-5b6c-7d8e-9f01-000000000002" }));
    expect(retry.awb).toBe(t.awbFor("0192f3a4-5b6c-7d8e-9f01-000000000002"));
    expect(t.byReference.size).toBe(2);
  });
  it("builds the COD amount in integer-safe EGP and weight rounded up", async () => {
    await c.createAwb(req());
    const sent = t.requests[0]?.body as { Shipments: { Details: { CashOnDeliveryAmount: { Value: number }; ActualWeight: { Value: number }; Services: string } }[] };
    expect(sent.Shipments[0]?.Details.CashOnDeliveryAmount.Value).toBe(1500.5);
    expect(sent.Shipments[0]?.Details.ActualWeight.Value).toBe(1.24);
    expect(sent.Shipments[0]?.Details.Services).toBe("CODS");
    await c.createAwb(req({ shipmentId: "0192f3a4-5b6c-7d8e-9f01-000000000003", cod: null }));
    const prepaid = t.requests[1]?.body as { Shipments: { Details: Record<string, unknown> }[] };
    expect(prepaid.Shipments[0]?.Details["CashOnDeliveryAmount"]).toBeUndefined();
    expect(piastresToEgp(5n)).toBe(0.05);
    expect(piastresToEgp(100n)).toBe(1);
    expect(() => piastresToEgp(-1n)).toThrow();
    expect(gramsToKg(1)).toBe(0.01);
  });
  it("maps failures: validation to rejected, 5xx/network/garbage to unavailable, 401 to rejected", async () => {
    t.mode = "unserviceable";
    await expect(c.createAwb(req())).rejects.toMatchObject({ code: "aramex_err52" });
    t.mode = "down";
    await expect(c.createAwb(req())).rejects.toBeInstanceOf(CourierUnavailableError);
    t.mode = "http_500";
    await expect(c.createAwb(req())).rejects.toBeInstanceOf(CourierUnavailableError);
    t.mode = "garbage";
    await expect(c.createAwb(req())).rejects.toBeInstanceOf(CourierUnavailableError);
    t.mode = "unauthorized";
    await expect(c.createAwb(req())).rejects.toBeInstanceOf(CourierRejectedError);
  });
  it("never leaks recipient data or credentials in error messages", async () => {
    t.mode = "down";
    const e = await c.createAwb(req()).then(() => new Error("unexpected success"), (x: unknown) => x as Error);
    expect(e.message).not.toMatch(/Mona|\+2010|fixture|Test St/);
    t.mode = "unserviceable";
    const r = await c.createAwb(req()).then(() => new Error("unexpected success"), (x: unknown) => x as Error);
    expect(r.message).not.toMatch(/Mona|\+2010|fixture|Test St/);
  });
  it("label, tracking and cancel", async () => {
    const { awb } = await c.createAwb(req());
    const label = await c.getLabel(awb);
    expect(label.contentType).toBe("application/pdf");
    expect(Buffer.from(label.bytes).subarray(0, 4).toString()).toBe("%PDF");
    await expect(c.getLabel("ARXNOPE00000")).rejects.toBeInstanceOf(CourierRejectedError);
    const facts = await c.track(awb);
    expect(facts.map((f) => f.kind)).toEqual(["picked_up", "out_for_delivery"]);
    expect(new Set(facts.map((f) => f.courierEventId)).size).toBe(2);
    expect((await c.track(awb)).map((f) => f.courierEventId)).toEqual(facts.map((f) => f.courierEventId));
    expect(await c.cancel(awb)).toBe("cancelled");
    t.shippedAwbs.add(awb);
    expect(await c.cancel(awb)).toBe("too_late");
    expect(mapAramexUpdateCode("ZZ999")).toBeNull();
    expect(t.requests.every((r) => Object.values(ARAMEX_PATHS).includes(r.path as never))).toBe(true);
  });
});

describe("hub outbound", () => {
  it("creates one AWB per parcel id and reports courier aramex", async () => {
    const out = new AramexHubOutbound(c);
    const parcel = { id: "0192f3a4-5b6c-7d8e-9f01-0000000000aa" } as never;
    const facts = { weightG: 900, pieces: 1, cod: null, recipient: req().recipient, pickup: req().pickup } as never;
    const a = await out.createOutbound(parcel, facts);
    const b = await out.createOutbound(parcel, facts);
    expect(a).toEqual(b);
    expect(a.courierCode).toBe("aramex");
    expect(a.costPiastres).toBe(0n);
  });
});

describe("module boot", () => {
  it("refuses to boot outside test mode without a transport and credentials", () => {
    expect(() => CourierAramexModule.forRoot(loadConfig({ NODE_ENV: "development" }))).toThrow(MissingAramexPortsError);
    expect(() => CourierAramexModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
  });
});
