import { describe, expect, it, vi } from "vitest";
import type { OutletClient } from "../../services/api-client";
import type { AdapterContext } from "../../services/wire";
import { ApiAddressesPort } from "./addresses-api";
import type { AddressForm } from "./model";

type Call = (...a: unknown[]) => Promise<unknown>;
const ok = (data: unknown) => Promise.resolve({ data, etag: null, notModified: false });
const port = (client: Record<string, Call>) =>
  new ApiAddressesPort({ client: client as unknown as OutletClient, locale: () => "ar", nowMs: () => 0, deviceId: () => "device-12345" } as AdapterContext);

const wireAddress = (over: Record<string, unknown> = {}) => ({
  id: "a1", label: "Home", recipient_name: "Nada", phone_e164: "+201000000000", is_default: true,
  governorate_code: "cairo", city_district_code: "nasr", street: "Street 9", building: "12", floor: "3", apartment: "5", landmark: "Mall", map_pin: { lat: 30.1, lng: 31.3 }, ...over,
});
const form = (over: Partial<AddressForm["draft"]> = {}, label = "  Home  "): AddressForm => ({
  label, recipientName: "  Nada ", phone: "+201000000000",
  draft: { governorateId: "cairo", cityId: "nasr", street: " Street 9 ", building: " 12 ", floor: "3", apartment: "  ", landmark: "", pin: { lat: 30.1, lng: 31.3 }, ...over },
});

describe("ApiAddressesPort", () => {
  it("list maps wire addresses and blanks optional parts", async () => {
    const list = await port({ listAddresses: () => ok({ items: [wireAddress(), wireAddress({ id: "a2", label: undefined, floor: undefined, apartment: undefined, landmark: undefined, map_pin: undefined, is_default: false })] }) }).list();
    expect(list[0]).toEqual({
      id: "a1", label: "Home", recipientName: "Nada", phone: "+201000000000", isDefault: true,
      draft: { governorateId: "cairo", cityId: "nasr", street: "Street 9", building: "12", floor: "3", apartment: "5", landmark: "Mall", pin: { lat: 30.1, lng: 31.3 } },
    });
    expect(list[1]).toMatchObject({ label: null, isDefault: false, draft: { floor: "", apartment: "", landmark: "", pin: null } });
  });

  it("create trims input and omits blank optional fields", async () => {
    const createAddress = vi.fn(() => ok(wireAddress()));
    await port({ createAddress }).create(form(), "k1");
    expect(createAddress).toHaveBeenCalledWith({
      body: { label: "Home", recipient_name: "Nada", phone_e164: "+201000000000", governorate_code: "cairo", city_district_code: "nasr", street: "Street 9", building: "12", floor: "3", map_pin: { lat: 30.1, lng: 31.3 } },
    }, { idempotencyKey: "k1" });
  });

  it("create without a label, pin or governorate sends empty codes rather than undefined", async () => {
    const createAddress = vi.fn(() => ok(wireAddress()));
    await port({ createAddress }).create(form({ governorateId: null, cityId: null, pin: null }, "   "), "k");
    const calls = createAddress.mock.calls as unknown as Array<[{ body: Record<string, unknown> }]>;
    const body = calls[0]?.[0].body ?? {};
    expect(body).toMatchObject({ governorate_code: "", city_district_code: "" });
    expect("label" in body).toBe(false);
    expect("map_pin" in body).toBe(false);
  });

  it("update, remove and setDefault address by id with the key", async () => {
    const updateAddress = vi.fn((_arg: unknown, _opts: unknown) => ok(wireAddress({ street: "New" })));
    const deleteAddress = vi.fn(() => ok({}));
    const setDefaultAddress = vi.fn(() => ok({}));
    const p = port({ updateAddress, deleteAddress, setDefaultAddress });
    expect((await p.update("a1", form(), "k2")).draft.street).toBe("New");
    await p.remove("a1", "k3");
    await p.setDefault("a1", "k4");
    expect(updateAddress.mock.calls[0]?.[0]).toMatchObject({ path: { addressId: "a1" } });
    expect(deleteAddress).toHaveBeenCalledWith({ path: { addressId: "a1" } }, { idempotencyKey: "k3" });
    expect(setDefaultAddress).toHaveBeenCalledWith({ path: { addressId: "a1" } }, { idempotencyKey: "k4" });
  });

  it("only offers governorates and cities the courier covers", async () => {
    const p = port({
      listCoverageGovernorates: () => ok({ items: [
        { code: "cairo", name_ar: "القاهرة", name_en: "Cairo", courier_coverage: "covered" },
        { code: "matrouh", name_ar: "مطروح", name_en: "Matrouh", courier_coverage: "not_covered" },
      ] }),
      listCoverageCities: () => ok({ items: [
        { code: "nasr", name_ar: "مدينة نصر", name_en: "Nasr City", courier_coverage: "covered" },
        { code: "far", name_ar: "بعيد", name_en: "Far", courier_coverage: "not_covered" },
      ] }),
    });
    expect(await p.governorates()).toEqual([{ id: "cairo", name: { ar: "القاهرة", en: "Cairo" }, cities: [] }]);
    expect(await p.cities("cairo")).toEqual([{ id: "nasr", name: { ar: "مدينة نصر", en: "Nasr City" } }]);
  });
});
