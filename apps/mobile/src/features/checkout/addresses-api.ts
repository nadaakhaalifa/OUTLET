import { dataOf, type schemas } from "../../services/api-client";
import { guard, type AdapterContext } from "../../services/wire";
import type { AddressForm, AddressesPort, City, Governorate, SavedAddress } from "./model";

function toSaved(a: schemas.Address): SavedAddress {
  return {
    id: a.id,
    label: a.label ?? null,
    recipientName: a.recipient_name,
    phone: a.phone_e164,
    isDefault: a.is_default,
    draft: {
      governorateId: a.governorate_code, cityId: a.city_district_code, street: a.street, building: a.building,
      floor: a.floor ?? "", apartment: a.apartment ?? "", landmark: a.landmark ?? "",
      pin: a.map_pin !== undefined ? { lat: a.map_pin.lat, lng: a.map_pin.lng } : null,
    },
  };
}

function toBody(f: AddressForm): schemas.AddressInput {
  const d = f.draft;
  const opt = (v: string): string | undefined => (v.trim() === "" ? undefined : v.trim());
  const label = opt(f.label);
  const floor = opt(d.floor);
  const apartment = opt(d.apartment);
  const landmark = opt(d.landmark);
  return {
    ...(label !== undefined ? { label } : {}),
    recipient_name: f.recipientName.trim(),
    phone_e164: f.phone,
    governorate_code: d.governorateId ?? "",
    city_district_code: d.cityId ?? "",
    street: d.street.trim(),
    building: d.building.trim(),
    ...(floor !== undefined ? { floor } : {}),
    ...(apartment !== undefined ? { apartment } : {}),
    ...(landmark !== undefined ? { landmark } : {}),
    ...(d.pin !== null ? { map_pin: { lat: d.pin.lat, lng: d.pin.lng } } : {}),
  };
}

/** listAddresses, createAddress, updateAddress, deleteAddress, setDefaultAddress, listCoverageGovernorates, listCoverageCities. */
export class ApiAddressesPort implements AddressesPort {
  constructor(private readonly ctx: AdapterContext) {}
  list(): Promise<readonly SavedAddress[]> {
    return guard(async () => dataOf(await this.ctx.client.listAddresses()).items.map(toSaved));
  }
  create(form: AddressForm, idempotencyKey: string): Promise<SavedAddress> {
    return guard(async () => toSaved(dataOf(await this.ctx.client.createAddress({ body: toBody(form) }, { idempotencyKey }))));
  }
  update(id: string, form: AddressForm, idempotencyKey: string): Promise<SavedAddress> {
    return guard(async () => toSaved(dataOf(await this.ctx.client.updateAddress({ path: { addressId: id }, body: toBody(form) }, { idempotencyKey }))));
  }
  remove(id: string, idempotencyKey: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.deleteAddress({ path: { addressId: id } }, { idempotencyKey }));
    });
  }
  setDefault(id: string, idempotencyKey: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.setDefaultAddress({ path: { addressId: id } }, { idempotencyKey }));
    });
  }
  governorates(): Promise<readonly Governorate[]> {
    return guard(async () => dataOf(await this.ctx.client.listCoverageGovernorates()).items
      .filter((g) => g.courier_coverage === "covered")
      .map((g) => ({ id: g.code, name: { ar: g.name_ar, en: g.name_en }, cities: [] })));
  }
  cities(governorateId: string): Promise<readonly City[]> {
    return guard(async () => dataOf(await this.ctx.client.listCoverageCities({ query: { governorate: governorateId } })).items
      .filter((c) => c.courier_coverage === "covered")
      .map((c) => ({ id: c.code, name: { ar: c.name_ar, en: c.name_en } })));
  }
}
