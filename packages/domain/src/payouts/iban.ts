import { InvalidIbanError } from "./errors";

/** Removes spaces and upper-cases. Does not validate. */
export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/** ISO 13616 mod-97 check on an already normalized IBAN. */
function mod97Ok(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= "0" && ch <= "9" ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of v) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

/** Egyptian IBAN: `EG` + 2 check digits + 25 digits = 29 characters, mod 97. */
export function isValidEgyptIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  return /^EG\d{27}$/.test(iban) && mod97Ok(iban);
}

export function assertEgyptIban(raw: string): string {
  const iban = normalizeIban(raw);
  if (!isValidEgyptIban(iban)) throw new InvalidIbanError("not a valid Egyptian IBAN");
  return iban;
}

/** Last four characters only: the only part of an IBAN this platform's payout tables may hold. */
export function ibanLast4(raw: string): string {
  return normalizeIban(raw).slice(-4);
}

const DIACRITICS = /[ً-ٰٟـ]/g;
const EASTERN_DIGITS = /[٠-٩]/g;
const COMPANY_TOKENS: ReadonlySet<string> = new Set([
  "llc",
  "ltd",
  "co",
  "company",
  "inc",
  "sae",
  "شركه",
  "شمم",
  "ذمم",
]);

/** Canonical form of a legal or account-holder name for comparison. Idempotent. */
export function normalizeLegalName(raw: string): string {
  const folded = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(EASTERN_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660));
  const tokens = folded
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !COMPANY_TOKENS.has(t));
  return [...new Set(tokens)].sort().join(" ");
}

export type NameMatch = "match" | "mismatch";

/**
 * Strict: the normalized token sets must be equal. A false negative costs a manual review, a
 * false positive pays the wrong party, so there is no fuzzy matching. Empty names never match.
 */
export function namesMatch(holderName: string, legalName: string): NameMatch {
  const a = normalizeLegalName(holderName);
  const b = normalizeLegalName(legalName);
  return a.length > 0 && a === b ? "match" : "mismatch";
}
