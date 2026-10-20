/** Address book view models (Me > Addresses). Pure: no React, no router. Port and fake live in checkout/model.ts. */
import { EMPTY_ADDRESS, validateAddress, type AddressDraft, type AddressForm, type Governorate, type SavedAddress } from "../checkout/model";

export type AddressBookField = "recipient" | "phone" | "governorate" | "city" | "street" | "building";

export interface AddressFormState {
  readonly label: string;
  readonly recipientName: string;
  /** What the person typed (any common Egyptian format). */
  readonly phoneInput: string;
  readonly draft: AddressDraft;
}

export const EMPTY_FORM: AddressFormState = { label: "", recipientName: "", phoneInput: "", draft: EMPTY_ADDRESS };

const EASTERN = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

/** Accepts 01XXXXXXXXX, +201XXXXXXXXX, 00201XXXXXXXXX (Western or Eastern digits). Returns E.164 or null. */
export function normalizeEgyptPhone(raw: string): string | null {
  const digits = [...raw.trim()].map((c) => {
    const e = EASTERN.indexOf(c);
    if (e >= 0) return String(e);
    const p = EASTERN_PERSIAN.indexOf(c);
    return p >= 0 ? String(p) : c;
  }).join("").replace(/[\s\-()]/g, "");
  let national: string;
  if (/^\+20\d{10}$/.test(digits)) national = digits.slice(3);
  else if (/^0020\d{10}$/.test(digits)) national = digits.slice(4);
  else if (/^0\d{10}$/.test(digits)) national = digits.slice(1);
  else return null;
  return /^1[0125]\d{8}$/.test(national) ? `+20${national}` : null;
}

export function validateAddressBookForm(f: AddressFormState, coverage: readonly Governorate[]): readonly AddressBookField[] {
  const errors: AddressBookField[] = [];
  if (f.recipientName.trim().length === 0) errors.push("recipient");
  if (normalizeEgyptPhone(f.phoneInput) === null) errors.push("phone");
  for (const e of validateAddress(f.draft, coverage, false)) {
    if (e === "governorate" || e === "city" || e === "street" || e === "building") errors.push(e);
  }
  return errors;
}

/** The port payload, or null while the form is invalid. */
export function toAddressForm(f: AddressFormState, coverage: readonly Governorate[]): AddressForm | null {
  const phone = normalizeEgyptPhone(f.phoneInput);
  if (phone === null || validateAddressBookForm(f, coverage).length > 0) return null;
  return { label: f.label.trim(), recipientName: f.recipientName.trim(), phone, draft: f.draft };
}

export function formFromSaved(a: SavedAddress): AddressFormState {
  return { label: a.label ?? "", recipientName: a.recipientName, phoneInput: a.phone ?? "", draft: a.draft };
}

/** Default address first, then the server order. */
export function orderAddresses(list: readonly SavedAddress[]): readonly SavedAddress[] {
  return [...list].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/** Setting a default is only offered for a saved address that is not already the default. */
export function canSetDefault(a: SavedAddress | null): boolean {
  return a !== null && !a.isDefault;
}
