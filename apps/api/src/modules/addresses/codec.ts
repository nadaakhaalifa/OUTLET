import type { addresses } from "@outlet/domain";
import type { FieldCipher } from "../auth";
import type { AddressRow, AddressView, SnapshotRow } from "./ports";

type Dec = (b: Uint8Array | null, field: string) => Promise<string | undefined>;

const enc = (c: FieldCipher, kind: string, id: string) => (v: string, field: string): Promise<Uint8Array> => c.encrypt(v, `${kind}:${id}:${field}`);
const encOpt = (c: FieldCipher, kind: string, id: string) => async (v: string | undefined, field: string): Promise<Uint8Array | null> =>
  v === undefined ? null : c.encrypt(v, `${kind}:${id}:${field}`);
const decOpt = (c: FieldCipher, kind: string, id: string): Dec => async (b, field) => (b === null ? undefined : c.decrypt(b, `${kind}:${id}:${field}`));

export interface PlainAddress {
  readonly recipientName: string;
  readonly phoneE164: string;
  readonly street: string;
  readonly building: string;
  readonly floor?: string | undefined;
  readonly apartment?: string | undefined;
  readonly landmark?: string | undefined;
  readonly mapPin?: addresses.MapPin | undefined;
}

export interface SealedFields {
  readonly recipientNameEnc: Uint8Array;
  readonly phoneEnc: Uint8Array;
  readonly streetEnc: Uint8Array;
  readonly buildingEnc: Uint8Array;
  readonly floorEnc: Uint8Array | null;
  readonly apartmentEnc: Uint8Array | null;
  readonly landmarkEnc: Uint8Array | null;
  readonly mapPinEnc: Uint8Array | null;
}

/** Field-level envelope encryption of the P3 address fields. A cipher failure (503 when KMS is Unconfigured) propagates. */
export class AddressCodec {
  constructor(private readonly cipher: FieldCipher) {}

  async seal(kind: "address" | "snapshot", id: string, p: PlainAddress): Promise<SealedFields> {
    const e = enc(this.cipher, kind, id);
    const o = encOpt(this.cipher, kind, id);
    return {
      recipientNameEnc: await e(p.recipientName, "recipient"),
      phoneEnc: await e(p.phoneE164, "phone"),
      streetEnc: await e(p.street, "street"),
      buildingEnc: await e(p.building, "building"),
      floorEnc: await o(p.floor, "floor"),
      apartmentEnc: await o(p.apartment, "apartment"),
      landmarkEnc: await o(p.landmark, "landmark"),
      mapPinEnc: await o(p.mapPin === undefined ? undefined : JSON.stringify({ lat: p.mapPin.lat, lng: p.mapPin.lng }), "pin"),
    };
  }

  async open(kind: "address" | "snapshot", id: string, r: SealedFields): Promise<PlainAddress> {
    const d = decOpt(this.cipher, kind, id);
    const need = async (b: Uint8Array, f: string): Promise<string> => (await d(b, f)) ?? "";
    const pinRaw = await d(r.mapPinEnc, "pin");
    const pin = pinRaw === undefined ? undefined : (JSON.parse(pinRaw) as addresses.MapPin);
    return {
      recipientName: await need(r.recipientNameEnc, "recipient"),
      phoneE164: await need(r.phoneEnc, "phone"),
      street: await need(r.streetEnc, "street"),
      building: await need(r.buildingEnc, "building"),
      floor: await d(r.floorEnc, "floor"),
      apartment: await d(r.apartmentEnc, "apartment"),
      landmark: await d(r.landmarkEnc, "landmark"),
      mapPin: pin === undefined ? undefined : { lat: Number(pin.lat), lng: Number(pin.lng) },
    };
  }

  async view(r: AddressRow): Promise<AddressView> {
    const p = await this.open("address", r.id, r);
    return {
      id: r.id,
      userId: r.userId,
      ...(r.label === null ? {} : { label: r.label }),
      recipientName: p.recipientName,
      phoneE164: p.phoneE164,
      governorateCode: r.governorateCode,
      cityDistrictCode: r.cityCode,
      street: p.street,
      building: p.building,
      ...(p.floor === undefined ? {} : { floor: p.floor }),
      ...(p.apartment === undefined ? {} : { apartment: p.apartment }),
      ...(p.landmark === undefined ? {} : { landmark: p.landmark }),
      ...(p.mapPin === undefined ? {} : { mapPin: p.mapPin }),
      courierCoverage: r.courierCoverage,
      codEligible: r.codEligible,
      qualityScore: r.qualityScore,
      isDefault: r.isDefault,
      createdAtMs: r.createdAtMs,
      updatedAtMs: r.updatedAtMs,
    };
  }

  async openSnapshot(r: SnapshotRow): Promise<PlainAddress> {
    return this.open("snapshot", r.id, r);
  }

  blind(purpose: string, value: string): Promise<Uint8Array> {
    return this.cipher.blindIndex(purpose, value);
  }
}
