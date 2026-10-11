import { createHash } from "node:crypto";
import {
  CourierRejectedError,
  CourierUnavailableError,
  type AwbRequest,
  type CourierPort,
  type LabelFile,
  type PolledTrackingFact,
} from "../../domain/ports";
import createOk from "./fixtures/create-delivery.201.json";
import unserviceable from "./fixtures/error-unserviceable.422.json";
import label from "./fixtures/label-a6.pdf.base64.json";

export type FakeBostaMode = "up" | "down" | "reject";

/**
 * Courier fake that replays the recorded-style fixtures. It never opens a socket. It reproduces
 * the two behaviours the queue depends on: idempotency by business reference, and a timeout
 * AFTER the courier created the delivery (`timeoutAfterCreate`).
 */
export class FakeBostaCourier implements CourierPort {
  readonly code = "bosta";
  mode: FakeBostaMode = "up";
  /** When true the next createAwb stores the delivery and then throws as if the response was lost. */
  timeoutAfterCreate = false;
  readonly created = new Map<string, string>();
  createCalls = 0;
  readonly cancelled = new Set<string>();
  readonly tracked = new Map<string, readonly PolledTrackingFact[]>();

  /** The AWB this fake assigns to a business reference (deterministic, so tests can pre-announce it). */
  awbFor(reference: string): string {
    const digest = createHash("sha256").update(`fake-bosta:${reference}`).digest("hex").slice(0, 10).toUpperCase();
    return createOk.body.data.trackingNumber.replace("{{TRACKING_NUMBER}}", digest);
  }

  async createAwb(req: AwbRequest): Promise<{ readonly awb: string }> {
    this.createCalls += 1;
    if (this.mode === "down") throw new CourierUnavailableError("fake bosta is down");
    if (this.mode === "reject") {
      throw new CourierRejectedError(`bosta_${unserviceable.body.code}`, unserviceable.body.message);
    }
    const existing = this.created.get(req.shipmentId);
    if (existing !== undefined) return { awb: existing };
    const awb = this.awbFor(req.shipmentId);
    this.created.set(req.shipmentId, awb);
    if (this.timeoutAfterCreate) {
      this.timeoutAfterCreate = false;
      throw new CourierUnavailableError("response lost after create");
    }
    return { awb };
  }

  async getLabel(awb: string): Promise<LabelFile> {
    if (this.mode === "down") throw new CourierUnavailableError("fake bosta is down");
    if (![...this.created.values()].includes(awb)) throw new CourierRejectedError("unknown_awb");
    return { contentType: "application/pdf", bytes: Uint8Array.from(Buffer.from(label.base64, "base64")) };
  }

  async track(awb: string): Promise<readonly PolledTrackingFact[]> {
    if (this.mode === "down") throw new CourierUnavailableError("fake bosta is down");
    return this.tracked.get(awb) ?? [];
  }

  async cancel(awb: string): Promise<"cancelled" | "too_late"> {
    if (this.mode === "down") throw new CourierUnavailableError("fake bosta is down");
    this.cancelled.add(awb);
    return "cancelled";
  }
}
