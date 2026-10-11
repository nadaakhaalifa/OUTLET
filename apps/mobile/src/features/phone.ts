import { isCountryAllowed, parseE164 } from "../workspace";

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

/** Maps Arabic-Indic and Persian digits to ASCII; leaves everything else unchanged. */
export function toAsciiDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= ARABIC_INDIC_ZERO && cp <= ARABIC_INDIC_ZERO + 9) out += String(cp - ARABIC_INDIC_ZERO);
    else if (cp >= EXTENDED_ARABIC_INDIC_ZERO && cp <= EXTENDED_ARABIC_INDIC_ZERO + 9) out += String(cp - EXTENDED_ARABIC_INDIC_ZERO);
    else out += ch;
  }
  return out;
}

export type PhoneResult =
  | { readonly ok: true; readonly e164: string }
  | { readonly ok: false; readonly reason: "empty" | "invalid" | "country_not_supported" };

/**
 * Client-side shape check only; the server is authoritative. Accepts national (01x...), 0020/+20
 * and Arabic-Indic input. The Egyptian mobile prefix set (10, 11, 12, 15) is a shape heuristic:
 * VERIFY BEFORE LAUNCH against the current NTRA numbering plan.
 */
export function normalizeEgyptianPhone(raw: string): PhoneResult {
  const ascii = toAsciiDigits(raw).trim();
  if (ascii.length === 0) return { ok: false, reason: "empty" };
  const digits = ascii.replace(/\D/g, "");
  if (digits.length === 0) return { ok: false, reason: "invalid" };
  let international: string;
  if (ascii.startsWith("+")) international = digits;
  else if (digits.startsWith("00")) international = digits.slice(2);
  else if (digits.startsWith("0")) international = `20${digits.slice(1)}`;
  else if (digits.startsWith("20")) international = digits;
  else international = `20${digits}`;
  let e164: string;
  try {
    e164 = parseE164(`+${international}`);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!isCountryAllowed(e164)) return { ok: false, reason: "country_not_supported" };
  if (!/^\+201[0125]\d{8}$/.test(e164)) return { ok: false, reason: "invalid" };
  return { ok: true, e164 };
}

/** For display only: masks the middle of an E.164 number. Never log the raw number. */
export function maskPhone(e164: string): string {
  if (e164.length < 8) return "***";
  return `${e164.slice(0, 5)}*****${e164.slice(-2)}`;
}
