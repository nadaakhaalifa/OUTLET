const EASTERN = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

/** Eastern Arabic (٠-٩) and Persian (۰-۹) digits become ASCII; everything else is untouched. */
export function toWesternDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const e = EASTERN.indexOf(ch);
    const p = PERSIAN.indexOf(ch);
    out += e >= 0 ? String(e) : p >= 0 ? String(p) : ch;
  }
  return out;
}

/** The input as typed, reduced to digits only (Eastern digits accepted). */
export function digitsOnly(input: string): string {
  return toWesternDigits(input).replace(/\D/g, "");
}

/**
 * Egyptian mobile (010/011/012/015) to E.164, or null. Accepts 01012345678, +201012345678, 00201012345678 and Eastern digits.
 * Never guesses: anything that is not exactly an Egyptian mobile returns null.
 */
export function normalizeEgPhone(input: string): string | null {
  let d = digitsOnly(input);
  if (d.startsWith("0020")) d = d.slice(4);
  else if (d.startsWith("20") && d.length === 12) d = d.slice(2);
  else if (d.startsWith("0") && d.length === 11) d = d.slice(1);
  return /^1[0125]\d{8}$/.test(d) ? `+20${d}` : null;
}

/** Six-digit code from user input (Eastern digits accepted), or null. */
export function normalizeCode(input: string): string | null {
  const d = digitsOnly(input);
  return /^\d{6}$/.test(d) ? d : null;
}

/** Masks a number for display: keeps the country prefix and the last three digits. */
export function maskPhone(e164: string): string {
  return e164.length <= 7 ? e164 : `${e164.slice(0, 4)}${"•".repeat(e164.length - 7)}${e164.slice(-3)}`;
}
