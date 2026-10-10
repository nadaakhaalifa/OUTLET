import { describe, expect, it } from "vitest";
import {
  BOSTA_STATUS_MAP_VERSION,
  BostaStyleWebhookAdapter,
  mapBostaStatus,
  signBostaWebhook,
} from "../adapters/bosta/bosta-adapter";
import { FakeBostaCourier } from "../adapters/bosta/fake-bosta";
import { CourierRejectedError, CourierUnavailableError } from "../domain/ports";
import { remittanceBody, sellerOrder, trackingBody } from "./harness";

const SECRET = "whsec_unit_0123456789";
const NOW = 1_800_000_000_000;
const adapter = new BostaStyleWebhookAdapter();
const headers = (raw: string, ts = Math.floor(NOW / 1000), secret = SECRET) => ({
  "x-signature": signBostaWebhook(secret, ts, raw),
  "x-timestamp": String(ts),
});

describe("BostaStyleWebhookAdapter.verify", () => {
  const raw = JSON.stringify(trackingBody("e1", "BST1", "Delivered", NOW));
  it("accepts a correct signature inside the window, with rotation", () => {
    expect(adapter.verify({ rawBody: raw, headers: headers(raw) }, [SECRET], NOW)).toBe("ok");
    expect(adapter.verify({ rawBody: raw, headers: headers(raw) }, ["other", SECRET], NOW)).toBe("ok");
  });
  it("rejects wrong secret, tampered body, missing and malformed headers", () => {
    expect(adapter.verify({ rawBody: raw, headers: headers(raw, undefined, "x") }, [SECRET], NOW)).toBe("bad_signature");
    expect(adapter.verify({ rawBody: raw + " ", headers: headers(raw) }, [SECRET], NOW)).toBe("bad_signature");
    expect(adapter.verify({ rawBody: raw, headers: {} }, [SECRET], NOW)).toBe("missing_headers");
    expect(adapter.verify({ rawBody: raw, headers: { "x-signature": "zz", "x-timestamp": "1800000000" } }, [SECRET], NOW)).toBe("bad_signature");
    expect(adapter.verify({ rawBody: raw, headers: headers(raw) }, [], NOW)).toBe("bad_signature");
  });
  it("enforces +/- 5 minutes on a correctly signed body", () => {
    const edge = Math.floor(NOW / 1000) - 300;
    expect(adapter.verify({ rawBody: raw, headers: headers(raw, edge) }, [SECRET], NOW)).toBe("ok");
    expect(adapter.verify({ rawBody: raw, headers: headers(raw, edge - 1) }, [SECRET], NOW)).toBe("stale_timestamp");
    expect(adapter.verify({ rawBody: raw, headers: headers(raw, Math.floor(NOW / 1000) + 301) }, [SECRET], NOW)).toBe("stale_timestamp");
  });
  it("accepts a millisecond timestamp header", () => {
    const ts = NOW;
    const h = { "x-signature": signBostaWebhook(SECRET, ts, raw), "x-timestamp": String(ts) };
    expect(adapter.verify({ rawBody: raw, headers: h }, [SECRET], NOW)).toBe("ok");
  });
});

describe("BostaStyleWebhookAdapter.parse", () => {
  it("maps tracking facts and normalizes seconds to milliseconds", () => {
    const p = adapter.parse(JSON.stringify(trackingBody("e1", "BST1", "Out for delivery", NOW)));
    expect(p).toMatchObject({ kind: "tracking", tracking: "out_for_delivery", awb: "BST1", courierEventId: "e1", occurredAtMs: NOW });
  });
  it("turns a refusal reason on a failed delivery into customer_refused", () => {
    const p = adapter.parse(JSON.stringify(trackingBody("e2", "BST1", "Delivery failed", NOW, "Customer refused to receive")));
    expect(p).toMatchObject({ tracking: "customer_refused" });
  });
  it("leaves an unknown state unmapped rather than failing", () => {
    expect(adapter.parse(JSON.stringify(trackingBody("e3", "BST1", "Teleported", NOW)))).toMatchObject({ kind: "tracking", tracking: null });
  });
  it("parses remittances to bigint piastres", () => {
    const p = adapter.parse(JSON.stringify(remittanceBody("r1", "CR-1", [{ awb: "BST1", collected: 150_000, fee: 2_500 }])));
    expect(p).toMatchObject({ kind: "cod_remitted", courierRef: "CR-1" });
    if (p.kind === "cod_remitted") {
      expect(p.lines[0]?.collected).toEqual({ amount: 150_000n, currency: "EGP" });
      expect(p.lines[0]?.fee.amount).toBe(2_500n);
    }
  });
  it("rejects malformed json, wrong shapes, floats and oversized fields", () => {
    expect(adapter.parse("not json").kind).toBe("invalid");
    expect(adapter.parse("{}").kind).toBe("invalid");
    expect(adapter.parse(JSON.stringify(remittanceBody("r1", "CR-1", [{ awb: "BST1", collected: 1.5 }]))).kind).toBe("invalid");
    expect(adapter.parse(JSON.stringify(trackingBody("x".repeat(200), "BST1", "Delivered", NOW))).kind).toBe("invalid");
    expect(adapter.parse(JSON.stringify({ ...trackingBody("e", "BST1", "Delivered", NOW), extra: 1 })).kind).toBe("tracking");
  });
  it("has a versioned status map and maps only known kinds", () => {
    expect(BOSTA_STATUS_MAP_VERSION).toMatch(/assumed/);
    expect(mapBostaStatus("  DELIVERED ")).toBe("delivered");
    expect(mapBostaStatus("nope")).toBeNull();
  });
});

describe("FakeBostaCourier", () => {
  const req = (id: string) => ({
    shipmentId: id,
    parcel: { weightG: 500, pieces: 1 },
    cod: null,
    recipient: sellerOrder(1, "s").recipient,
    pickup: sellerOrder(1, "s").pickup,
  });
  it("is idempotent by shipment id", async () => {
    const f = new FakeBostaCourier();
    const a = await f.createAwb(req("s-1"));
    const b = await f.createAwb(req("s-1"));
    const c = await f.createAwb(req("s-2"));
    expect(b.awb).toBe(a.awb);
    expect(c.awb).not.toBe(a.awb);
  });
  it("fails the ways the queue depends on", async () => {
    const f = new FakeBostaCourier();
    f.mode = "down";
    await expect(f.createAwb(req("s-1"))).rejects.toBeInstanceOf(CourierUnavailableError);
    f.mode = "reject";
    await expect(f.createAwb(req("s-1"))).rejects.toBeInstanceOf(CourierRejectedError);
    f.mode = "up";
    f.timeoutAfterCreate = true;
    await expect(f.createAwb(req("s-9"))).rejects.toBeInstanceOf(CourierUnavailableError);
    expect((await f.createAwb(req("s-9"))).awb).toBe(f.awbFor("s-9"));
  });
  it("serves a label only for a known AWB and cancels", async () => {
    const f = new FakeBostaCourier();
    const { awb } = await f.createAwb(req("s-1"));
    expect((await f.getLabel(awb)).bytes.length).toBeGreaterThan(10);
    await expect(f.getLabel("BSTNOPE")).rejects.toBeInstanceOf(CourierRejectedError);
    expect(await f.cancel(awb)).toBe("cancelled");
  });
});
