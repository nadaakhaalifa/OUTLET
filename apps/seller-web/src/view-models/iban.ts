import type { MessageKey } from "../i18n";

/** Egyptian IBAN: "EG" + 2 check digits + 25 digits = 29 characters (ISO 13616 mod-97). Pure, no I/O. */
export const EG_IBAN_LENGTH = 29;

export const normalizeIban = (raw: string): string => raw.replace(/[\s‎‏-]/g, "").toUpperCase();

/** ISO 7064 mod 97-10 over the rearranged string, processed in chunks so no BigInt is needed. */
export function mod97(rearranged: string): number | null {
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    let digits: string;
    if (code >= 48 && code <= 57) digits = ch;
    else if (code >= 65 && code <= 90) digits = String(code - 55);
    else return null;
    for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem;
}

export type IbanProblem = "empty" | "country" | "length" | "characters" | "checksum";

export interface IbanCheck {
  readonly valid: boolean;
  readonly normalized: string;
  readonly problem: IbanProblem | null;
}

export function checkEgyptIban(raw: string): IbanCheck {
  const n = normalizeIban(raw);
  const fail = (problem: IbanProblem): IbanCheck => ({ valid: false, normalized: n, problem });
  if (n.length === 0) return fail("empty");
  if (!n.startsWith("EG")) return fail("country");
  if (!/^EG[0-9]{27}$/.test(n)) return n.length !== EG_IBAN_LENGTH ? fail("length") : fail("characters");
  const rearranged = n.slice(4) + n.slice(0, 4);
  return mod97(rearranged) === 1 ? { valid: true, normalized: n, problem: null } : fail("checksum");
}

export const IBAN_PROBLEM_KEY: Readonly<Record<IbanProblem, MessageKey>> = {
  empty: "ob.iban.err.empty",
  country: "ob.iban.err.country",
  length: "ob.iban.err.length",
  characters: "ob.iban.err.characters",
  checksum: "ob.iban.err.checksum",
};

/** Groups of four for typing comfort ("EG12 3456 ..."). */
export const formatIban = (raw: string): string => normalizeIban(raw).replace(/(.{4})/g, "$1 ").trim();

/** Display mask from the server's last4 only; the full number is never held after submit. */
export const maskIbanLast4 = (last4: string): string => `EG•• •••• •••• •••• •••• ••• ${last4.replace(/[^0-9]/g, "").slice(-4)}`;
