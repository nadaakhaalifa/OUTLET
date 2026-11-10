import type { AddressInput as PkgInput, AddressView } from "@outlet/shipping";
import { Problems } from "../../platform/problem.js";
import type { Address, AddressInput } from "./dto.js";
import type { GeoPort } from "./services.js";

const E7 = 10_000_000;

/** Contract ids (geo_areas) to the package's governorate / city / district codes. A foreign-market or inactive id is 422, never guessed. */
export const toPackageInput = async (geo: GeoPort, b: AddressInput): Promise<PkgInput> => {
  const areas = await geo.byIds([b.fields.governorate_id, b.fields.district_id]);
  const gov = areas.find((a) => a.id === b.fields.governorate_id);
  const leaf = areas.find((a) => a.id === b.fields.district_id);
  if (gov?.level !== "governorate" || leaf === undefined) throw Problems.unprocessable("address-area-invalid", [{ path: "/body/fields", code: "invalid_area" }]);
  let cityCode: string | undefined;
  let districtCode: string | undefined;
  if (leaf.level === "city" && leaf.parentId === gov.id) cityCode = leaf.code;
  else if (leaf.level === "district" && leaf.parentId !== null) {
    const city = (await geo.byIds([leaf.parentId]))[0];
    if (city?.level !== "city" || city.parentId !== gov.id) throw Problems.unprocessable("address-area-invalid", [{ path: "/body/fields/district_id", code: "invalid_area" }]);
    cityCode = city.code;
    districtCode = leaf.code;
  } else throw Problems.unprocessable("address-area-invalid", [{ path: "/body/fields/district_id", code: "invalid_area" }]);
  const f = b.fields;
  return {
    ...(b.label === undefined ? {} : { label: b.label }),
    recipientName: b.recipient_name,
    phone: b.phone_e164,
    address: {
      governorateCode: gov.code,
      cityCode,
      ...(districtCode === undefined ? {} : { districtCode }),
      street: f.street,
      building: f.building,
      ...(f.floor == null ? {} : { floor: f.floor }),
      ...(f.apartment == null ? {} : { apartment: f.apartment }),
      landmark: f.landmark,
      ...(b.pin === undefined ? {} : { pin: { lat: b.pin.lat_e7 / E7, lng: b.pin.lng_e7 / E7 } }),
    },
    ...(b.is_default === undefined ? {} : { isDefault: b.is_default }),
  };
};

/** Package views to the contract shape; area ids come from one batched code lookup. */
export const toWire = async (geo: GeoPort, userId: string, views: readonly AddressView[]): Promise<Address[]> => {
  const codes = [...new Set(views.flatMap((v) => [v.address.governorateCode, v.address.cityCode, v.address.districtCode]).filter((c): c is string => c !== undefined))];
  const [areas, stamps] = await Promise.all([geo.byCodes(codes), geo.stamps(userId, views.map((v) => v.id))]);
  const id = (code: string | undefined): string => areas.find((a) => a.code === code)?.id ?? "";
  return views.map((v) => {
    const leaf = id(v.address.districtCode ?? v.address.cityCode);
    const s = stamps.get(v.id);
    return {
      id: v.id,
      country_code: "EG" as const,
      label: v.label,
      recipient_name: v.recipientName,
      phone_e164: v.phone,
      fields: {
        governorate_id: id(v.address.governorateCode),
        district_id: leaf,
        street: v.address.street,
        building: v.address.building,
        floor: v.address.floor ?? null,
        apartment: v.address.apartment ?? null,
        landmark: v.address.landmark ?? "",
      },
      pin: v.address.pin === undefined ? null : { lat_e7: Math.round(v.address.pin.lat * E7), lng_e7: Math.round(v.address.pin.lng * E7) },
      geo_area_id: leaf,
      is_default: v.isDefault,
      cod_eligible: v.codEligible,
      validated_at: s?.validatedAt?.toISOString() ?? null,
      created_at: (s?.createdAt ?? new Date(0)).toISOString(),
    };
  });
};
