import { SellerSettingsError } from "./errors";

export const DEFAULT_HANDLING_HOURS = 48;
export const MIN_HANDLING_HOURS = 12;
export const MAX_HANDLING_HOURS = 168;

/** Bosta first (spec 21), then Aramex, then Mylerz and J&T. */
export const COURIER_CODES = ["bosta", "aramex", "mylerz", "jt"] as const;
export type CourierCode = (typeof COURIER_CODES)[number];

export const PACKAGING_OPTIONS = ["standard_box", "branded_box", "poly_mailer", "garment_bag", "eco_packaging"] as const;
export type PackagingOption = (typeof PACKAGING_OPTIONS)[number];

const GOVERNORATE = /^EG-[A-Z]{1,3}$/;
const CITY = /^[a-z0-9-]{2,60}$/;

export function validateHandlingHours(h: number): number {
  if (!Number.isInteger(h) || h < MIN_HANDLING_HOURS || h > MAX_HANDLING_HOURS) {
    throw new SellerSettingsError("handling_time_out_of_range");
  }
  return h;
}

export interface ShippingOrigin {
  readonly governorateCode: string;
  readonly cityCode: string;
  readonly street: string;
  readonly building: string | null;
  readonly landmark: string;
  readonly contactName: string;
  readonly contactPhoneE164: string;
  readonly pin: { readonly lat: number; readonly lng: number } | null;
}

export function validateOrigin(o: ShippingOrigin): ShippingOrigin {
  if (!GOVERNORATE.test(o.governorateCode) || !CITY.test(o.cityCode)) throw new SellerSettingsError("origin_area_invalid");
  const street = o.street.trim();
  const landmark = o.landmark.trim();
  const name = o.contactName.trim();
  if (street.length < 3 || street.length > 200) throw new SellerSettingsError("origin_street_invalid");
  if (landmark.length < 2 || landmark.length > 120) throw new SellerSettingsError("origin_landmark_required");
  if (name.length < 2 || name.length > 80) throw new SellerSettingsError("origin_contact_invalid");
  const building = o.building === null ? null : o.building.trim().slice(0, 40) || null;
  if (o.pin !== null) {
    const { lat, lng } = o.pin;
    if (!(lat >= 22 && lat <= 31.7 && lng >= 24.7 && lng <= 36.9)) throw new SellerSettingsError("origin_pin_outside_egypt");
  }
  return { ...o, street, landmark, contactName: name, building };
}

export type CourierPreferences = Readonly<Record<string, readonly CourierCode[]>>;

/** Per-governorate ordered courier list (first is preferred). "default" applies to unlisted governorates. */
export function validateCourierPreferences(prefs: Readonly<Record<string, readonly string[]>>): CourierPreferences {
  const out: Record<string, readonly CourierCode[]> = {};
  for (const [gov, list] of Object.entries(prefs)) {
    if (gov !== "default" && !GOVERNORATE.test(gov)) throw new SellerSettingsError("courier_governorate_invalid");
    if (list.length < 1 || list.length > 3 || new Set(list).size !== list.length) {
      throw new SellerSettingsError("courier_list_invalid");
    }
    for (const c of list) if (!(COURIER_CODES as readonly string[]).includes(c)) throw new SellerSettingsError("courier_unknown");
    out[gov] = list as readonly CourierCode[];
  }
  return out;
}

export function courierOrderFor(prefs: CourierPreferences, governorateCode: string): readonly CourierCode[] {
  return prefs[governorateCode] ?? prefs["default"] ?? ["bosta"];
}

export function validatePackaging(options: readonly string[]): readonly PackagingOption[] {
  if (options.length < 1 || new Set(options).size !== options.length) throw new SellerSettingsError("packaging_invalid");
  for (const o of options) if (!(PACKAGING_OPTIONS as readonly string[]).includes(o)) throw new SellerSettingsError("packaging_invalid");
  return options as readonly PackagingOption[];
}
