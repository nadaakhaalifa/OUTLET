import { createHash } from "node:crypto";
import type { AramexCredentials, AramexCredentialsPort, AramexResponse, AramexTransport } from "../domain/ports";
import { PATHS } from "./aramex-courier";
import createOk from "./fixtures/create-shipments.ok.json";
import createError from "./fixtures/create-shipments.error.json";
import label from "./fixtures/label.base64.json";
import trackOk from "./fixtures/track.ok.json";

export type FakeAramexMode = "up" | "down" | "http_500" | "unserviceable" | "garbage" | "unauthorized";

export class StaticAramexCredentials implements AramexCredentialsPort {
  async get(): Promise<AramexCredentials> {
    return { accountNumber: "0000000", accountPin: "000000", accountEntity: "CAI", accountCountryCode: "EG", userName: "fixture", password: "fixture", version: "v1.0" };
  }
}

const sub = (v: unknown, from: string, to: string): unknown => JSON.parse(JSON.stringify(v).split(from).join(to));

/**
 * Replays the recorded-style fixtures. Never opens a socket. It also models the one behaviour the
 * queue depends on, ASSUMED here: a repeated Reference1 returns the same shipment (VERIFY, if
 * Aramex does not dedupe, the adapter needs a lookup-before-create).
 */
export class FakeAramexTransport implements AramexTransport {
  mode: FakeAramexMode = "up";
  /** Stores the shipment, then fails the response as if the connection dropped. */
  timeoutAfterCreate = false;
  readonly byReference = new Map<string, string>();
  readonly requests: { path: string; body: unknown }[] = [];
  readonly cancelled = new Set<string>();
  shippedAwbs = new Set<string>();

  awbFor(reference: string): string {
    return `ARX${createHash("sha256").update(`fake-aramex:${reference}`).digest("hex").slice(0, 9).toUpperCase()}`;
  }

  async post(path: string, body: unknown): Promise<AramexResponse> {
    this.requests.push({ path, body });
    if (this.mode === "down") throw new Error("ECONNREFUSED fake aramex");
    if (this.mode === "http_500") return { status: 503, body: {} };
    if (this.mode === "unauthorized") return { status: 401, body: {} };
    if (this.mode === "garbage") return { status: 200, body: { nope: true } };
    const b = body as { Shipments?: { Reference1?: string }[] | string[]; ShipmentNumber?: string; Reference1?: string };
    switch (path) {
      case PATHS.create: {
        if (this.mode === "unserviceable") return { status: createError.status, body: createError.body };
        const ref = (b.Shipments?.[0] as { Reference1?: string } | undefined)?.Reference1 ?? "";
        const existing = this.byReference.get(ref);
        const awb = existing ?? this.awbFor(ref);
        this.byReference.set(ref, awb);
        if (this.timeoutAfterCreate) {
          this.timeoutAfterCreate = false;
          throw new Error("ETIMEDOUT fake aramex");
        }
        return { status: createOk.status, body: sub(sub(createOk.body, "{{AWB}}", awb), "{{REFERENCE}}", ref) };
      }
      case PATHS.label: {
        const awb = b.ShipmentNumber ?? "";
        if (![...this.byReference.values()].includes(awb)) return { status: 200, body: { HasErrors: true, Notifications: [{ Code: "ERR30", Message: "unknown shipment" }] } };
        return { status: label.status, body: label.body };
      }
      case PATHS.track: {
        const awb = (b.Shipments as string[] | undefined)?.[0] ?? "";
        return { status: trackOk.status, body: sub(trackOk.body, "{{AWB}}", awb) };
      }
      case PATHS.cancelPickup: {
        const awb = b.Reference1 ?? "";
        if (this.shippedAwbs.has(awb)) return { status: 200, body: { HasErrors: true, Notifications: [{ Code: "ERR90" }] } };
        this.cancelled.add(awb);
        return { status: 200, body: { HasErrors: false, Notifications: [] } };
      }
      default:
        return { status: 404, body: {} };
    }
  }
}
