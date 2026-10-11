import { z } from "zod";
import {
  CourierRejectedError,
  CourierUnavailableError,
  type AwbRequest,
  type CourierPort,
} from "../../fulfillment";
import type { AramexCredentialsPort, AramexTransport } from "../domain/ports";
import statusMap from "./fixtures/status-map.json";

/**
 * Aramex adapter behind the fulfillment CourierPort. EVERY endpoint path, field name, update code,
 * unit and idempotency behaviour here is an ASSUMPTION modelled on Aramex's public Shipping
 * Services API and recorded-style fixtures. VERIFY BEFORE LAUNCH (register: Aramex API spec,
 * contract, sandbox, COD remittance cycle). No real HTTP happens in this module.
 */
type PolledTrackingFact = Awaited<ReturnType<CourierPort["track"]>>[number];

export const ARAMEX_STATUS_MAP_VERSION: string = statusMap.version;

export const PATHS = {
  create: "ShippingAPI.V2/Shipping/Service_1_0.svc/json/CreateShipments",
  label: "ShippingAPI.V2/Shipping/Service_1_0.svc/json/PrintLabel",
  track: "ShippingAPI.V2/Tracking/Service_1_0.svc/json/TrackShipments",
  cancelPickup: "ShippingAPI.V2/Shipping/Service_1_0.svc/json/CancelPickup",
} as const;

const KIND = z.enum([
  "label_created",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "delivery_failed",
  "customer_refused",
  "rto_initiated",
  "rto_delivered",
  "cancelled",
  "lost",
]);
const MAP: ReadonlyMap<string, z.infer<typeof KIND>> = new Map(
  Object.entries(statusMap.map).flatMap(([k, v]) => {
    const p = KIND.safeParse(v);
    return p.success ? [[k, p.data] as const] : [];
  }),
);
export const mapAramexUpdateCode = (code: string): z.infer<typeof KIND> | null => MAP.get(code.trim().toUpperCase()) ?? null;

const Notification = z.object({ Code: z.string().max(40), Message: z.string().max(300).optional() });
const CreateResponse = z.object({
  HasErrors: z.boolean(),
  Notifications: z.array(Notification).default([]),
  Shipments: z.array(z.object({ ID: z.string().min(3).max(64), HasErrors: z.boolean().default(false), Notifications: z.array(Notification).default([]) })).default([]),
});
const LabelResponse = z.object({
  HasErrors: z.boolean(),
  Notifications: z.array(Notification).default([]),
  ShipmentLabel: z.object({ LabelFileContents: z.string().min(8) }).optional(),
});
const TrackResponse = z.object({
  HasErrors: z.boolean(),
  Notifications: z.array(Notification).default([]),
  TrackingResults: z
    .array(
      z.object({
        Key: z.string(),
        Value: z.array(
          z.object({
            WaybillNumber: z.string(),
            UpdateCode: z.string().max(20),
            UpdateDescription: z.string().max(200).optional(),
            UpdateDateTime: z.string(),
            Comments: z.string().max(300).optional(),
          }),
        ),
      }),
    )
    .default([]),
});
const CancelResponse = z.object({ HasErrors: z.boolean(), Notifications: z.array(Notification).default([]) });

/** Integer piastres to a two-decimal EGP number, with no float arithmetic on the way. */
export function piastresToEgp(p: bigint): number {
  if (p < 0n) throw new RangeError("amount must not be negative");
  const q = p / 100n;
  const r = p % 100n;
  return Number(`${q.toString()}.${r.toString().padStart(2, "0")}`);
}
/** Grams to kilograms, rounded UP to 10 g (a courier never under-weighs). */
export function gramsToKg(g: number): number {
  const tens = Math.ceil(Math.max(g, 1) / 10);
  return tens / 100;
}
const stableHash = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
};

const TRANSIENT = (s: number): boolean => s === 408 || s === 429 || s >= 500;

export class AramexCourier implements CourierPort {
  readonly code = "aramex";
  constructor(
    private readonly transport: AramexTransport,
    private readonly credentials: AramexCredentialsPort,
  ) {}

  private async call<T>(path: string, payload: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const c = await this.credentials.get();
    const ClientInfo = {
      AccountNumber: c.accountNumber,
      AccountPin: c.accountPin,
      AccountEntity: c.accountEntity,
      AccountCountryCode: c.accountCountryCode,
      UserName: c.userName,
      Password: c.password,
      Version: c.version,
    };
    let res;
    try {
      res = await this.transport.post(path, { ClientInfo, ...payload });
    } catch {
      // Never include the cause: it may echo the request (recipient data, credentials).
      throw new CourierUnavailableError("aramex transport failure");
    }
    if (TRANSIENT(res.status)) throw new CourierUnavailableError(`aramex http ${res.status}`);
    if (res.status === 401 || res.status === 403) throw new CourierRejectedError("aramex_auth", "aramex refused the credentials");
    if (res.status < 200 || res.status >= 300) throw new CourierRejectedError(`aramex_http_${res.status}`);
    const parsed = schema.safeParse(res.body);
    // A body we cannot read is not proof the shipment failed: retry later rather than reject.
    if (!parsed.success) throw new CourierUnavailableError("aramex response not understood");
    return parsed.data;
  }

  async createAwb(req: AwbRequest): Promise<{ readonly awb: string }> {
    const r = await this.call(
      PATHS.create,
      {
        Shipments: [
          {
            Reference1: req.shipmentId,
            Shipper: {
              Reference1: req.shipmentId,
              PartyAddress: { Line1: req.pickup.addressLine, City: req.pickup.city, CountryCode: "EG" },
              Contact: { PersonName: req.pickup.label, CompanyName: req.pickup.label, PhoneNumber1: "" },
            },
            Consignee: {
              PartyAddress: { Line1: req.recipient.addressLine, City: req.recipient.city, StateOrProvinceCode: req.recipient.governorate, CountryCode: "EG" },
              Contact: { PersonName: req.recipient.name, PhoneNumber1: req.recipient.phone },
            },
            Details: {
              ActualWeight: { Unit: "KG", Value: gramsToKg(req.parcel.weightG) },
              NumberOfPieces: req.parcel.pieces,
              ProductGroup: "DOM",
              ProductType: "OND",
              PaymentType: "P",
              DescriptionOfGoods: "Apparel",
              Services: req.cod === null ? "" : "CODS",
              ...(req.cod === null ? {} : { CashOnDeliveryAmount: { Value: piastresToEgp(req.cod.amount), CurrencyCode: "EGP" } }),
            },
          },
        ],
        LabelInfo: { ReportID: 9201, ReportType: "URL" },
      },
      CreateResponse,
    );
    const first = r.Shipments[0];
    if (r.HasErrors || first === undefined || first.HasErrors) {
      const n = r.Notifications[0] ?? first?.Notifications[0];
      throw new CourierRejectedError(`aramex_${(n?.Code ?? "unknown").toLowerCase()}`, "aramex rejected the shipment");
    }
    return { awb: first.ID };
  }

  async getLabel(awb: string) {
    const r = await this.call(PATHS.label, { ShipmentNumber: awb, LabelInfo: { ReportID: 9201, ReportType: "RPT" } }, LabelResponse);
    const file = r.ShipmentLabel?.LabelFileContents;
    if (r.HasErrors || file === undefined) throw new CourierRejectedError("aramex_label_unavailable");
    return { contentType: "application/pdf" as const, bytes: Uint8Array.from(Buffer.from(file, "base64")) };
  }

  async track(awb: string): Promise<readonly PolledTrackingFact[]> {
    const r = await this.call(PATHS.track, { Shipments: [awb], GetLastTrackingUpdateOnly: false }, TrackResponse);
    if (r.HasErrors) return [];
    const out: PolledTrackingFact[] = [];
    for (const res of r.TrackingResults) {
      for (const u of res.Value) {
        if (u.WaybillNumber !== awb) continue;
        const at = Date.parse(u.UpdateDateTime);
        if (!Number.isFinite(at)) continue;
        out.push({
          // Aramex has no event id: derive a stable one so replays dedupe.
          courierEventId: `aramex:${awb}:${u.UpdateCode}:${at}:${stableHash(u.UpdateDescription ?? "")}`,
          rawStatus: u.UpdateCode,
          kind: mapAramexUpdateCode(u.UpdateCode),
          occurredAtMs: at,
          reasonCode: u.Comments === undefined || u.Comments === "" ? null : u.Comments.slice(0, 64),
        });
      }
    }
    return out.sort((a, b) => a.occurredAtMs - b.occurredAtMs);
  }

  async cancel(awb: string): Promise<"cancelled" | "too_late"> {
    const r = await this.call(PATHS.cancelPickup, { Reference1: awb }, CancelResponse);
    return r.HasErrors ? "too_late" : "cancelled";
  }
}
