import { describe, expect, it } from "vitest";
import { FIXTURE_COVERAGE, InMemoryAddressesPort } from "../checkout/model";
import { EMPTY_FORM, canSetDefault, formFromSaved, normalizeEgyptPhone, orderAddresses, toAddressForm, validateAddressBookForm } from "./model";

describe("normalizeEgyptPhone", () => {
  it("accepts common formats and Eastern digits", () => {
    expect(normalizeEgyptPhone("01012345678")).toBe("+201012345678");
    expect(normalizeEgyptPhone("+20 101 234 5678")).toBe("+201012345678");
    expect(normalizeEgyptPhone("00201012345678")).toBe("+201012345678");
    expect(normalizeEgyptPhone("٠١٠١٢٣٤٥٦٧٨")).toBe("+201012345678");
  });
  it("rejects landlines and junk", () => {
    expect(normalizeEgyptPhone("0212345678")).toBeNull();
    expect(normalizeEgyptPhone("12345")).toBeNull();
    expect(normalizeEgyptPhone("01312345678")).toBeNull();
  });
});

describe("form validation", () => {
  const ok = { ...EMPTY_FORM, recipientName: "Mona", phoneInput: "01012345678", draft: { ...EMPTY_FORM.draft, governorateId: "cairo", cityId: "nasr", street: "Abbas", building: "12" } };
  it("flags every missing field on an empty form", () => {
    expect(validateAddressBookForm(EMPTY_FORM, FIXTURE_COVERAGE)).toEqual(["recipient", "phone", "governorate", "street", "building"]);
  });
  it("builds a payload only when valid", () => {
    expect(toAddressForm(EMPTY_FORM, FIXTURE_COVERAGE)).toBeNull();
    expect(toAddressForm(ok, FIXTURE_COVERAGE)?.phone).toBe("+201012345678");
  });
  it("rejects a city outside the governorate", () => {
    expect(validateAddressBookForm({ ...ok, draft: { ...ok.draft, cityId: "dokki" } }, FIXTURE_COVERAGE)).toEqual(["city"]);
  });
});

describe("in-memory address book", () => {
  it("creates, edits, defaults and deletes", async () => {
    const port = new InMemoryAddressesPort([]);
    const f = toAddressForm({ ...EMPTY_FORM, recipientName: "A", phoneInput: "01012345678", draft: { ...EMPTY_FORM.draft, governorateId: "giza", cityId: "dokki", street: "S", building: "1" } }, FIXTURE_COVERAGE);
    if (f === null) throw new Error("form invalid");
    const a = await port.create(f, "k1");
    expect(a.isDefault).toBe(true);
    const b = await port.create({ ...f, label: "Work" }, "k2");
    expect(b.isDefault).toBe(false);
    await port.setDefault(b.id, "k3");
    expect(orderAddresses(await port.list())[0]?.id).toBe(b.id);
    await port.update(b.id, { ...f, recipientName: "B" }, "k4");
    expect(formFromSaved((await port.list()).find((x) => x.id === b.id) ?? a).recipientName).toBe("B");
    await port.remove(b.id, "k5");
    const left = await port.list();
    expect(left).toHaveLength(1);
    expect(left[0]?.isDefault).toBe(true);
    expect(canSetDefault(left[0] ?? null)).toBe(false);
  });
});
