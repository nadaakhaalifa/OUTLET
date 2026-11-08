import { z } from "zod";
import { pageOf } from "../../platform/pagination.js";
import { CursorQuery } from "../../platform/pagination.js";

const Iso = z.iso.datetime();
const Text = z.string().trim().min(1).max(500);

/** Contract `EgAddressFields`: the governorate and the most specific area (city or district) are geo_areas ids, never free text. */
export const AddressFields = z.strictObject({
  governorate_id: z.uuid(),
  district_id: z.uuid(),
  street: Text,
  building: Text,
  floor: z.string().trim().min(1).max(500).nullish(),
  apartment: z.string().trim().min(1).max(500).nullish(),
  landmark: Text,
});
export type AddressFields = z.infer<typeof AddressFields>;

/** Integer degrees x 1e7 on the wire (no floats). */
export const MapPin = z.strictObject({ lat_e7: z.number().int().min(-900_000_000).max(900_000_000), lng_e7: z.number().int().min(-1_800_000_000).max(1_800_000_000) });

export const AddressInput = z.strictObject({
  country_code: z.literal("EG"),
  label: z.string().trim().min(1).max(40).optional(),
  recipient_name: z.string().trim().min(1).max(120),
  phone_e164: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  fields: AddressFields,
  pin: MapPin.optional(),
  is_default: z.boolean().optional(),
});
export type AddressInput = z.infer<typeof AddressInput>;

export const Address = z.strictObject({
  id: z.uuid(),
  country_code: z.literal("EG"),
  label: z.string().max(500).nullable(),
  recipient_name: z.string().max(500),
  phone_e164: z.string().max(20),
  fields: AddressFields,
  pin: MapPin.nullable(),
  geo_area_id: z.uuid(),
  is_default: z.boolean(),
  /** COD needs a landmark and a map pin (master prompt 20.7). */
  cod_eligible: z.boolean(),
  validated_at: Iso.nullable(),
  created_at: Iso,
});
export type Address = z.infer<typeof Address>;

export const AddressPage = pageOf(Address);
export type AddressPage = z.infer<typeof AddressPage>;
export const AddressesQuery = CursorQuery;
export type AddressesQuery = z.infer<typeof AddressesQuery>;
export const AddressIdParams = z.strictObject({ address_id: z.uuid() });
export type AddressIdParams = z.infer<typeof AddressIdParams>;

export const GeoAreasQuery = CursorQuery.extend({ parent_id: z.uuid().optional(), level: z.enum(["governorate", "city", "district"]).optional() });
export type GeoAreasQuery = z.infer<typeof GeoAreasQuery>;
export const GeoArea = z.strictObject({
  id: z.uuid(),
  parent_id: z.uuid().nullable(),
  level: z.enum(["governorate", "city", "district"]),
  code: z.string().max(64),
  name_ar: z.string().min(1).max(500),
  name_en: z.string().max(500).nullable(),
  shipping_zone_code: z.string().max(64).nullable(),
  active: z.boolean(),
});
export const GeoAreaPage = pageOf(GeoArea);
export type GeoAreaPage = z.infer<typeof GeoAreaPage>;
