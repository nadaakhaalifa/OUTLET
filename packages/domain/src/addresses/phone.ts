const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const E164_EG_MOBILE = /^\+201[0125]\d{8}$/;

/**
 * Normalizes an Egyptian MOBILE number to E.164 (+201XXXXXXXXX). Accepts 01XXXXXXXXX, 201XXXXXXXXX,
 * 00201XXXXXXXXX, +201XXXXXXXXX, spaces/dashes/dots and Arabic-Indic digits. Returns null when the
 * input is not a valid EG mobile (prefixes 010, 011, 012, 015).
 */
export function normalizeEgPhone(raw: string): string | null {
  let s = "";
  for (const ch of raw.trim()) {
    const idx = ARABIC_INDIC.indexOf(ch);
    s += idx >= 0 ? String(idx) : ch;
  }
  if (/[^\d+\s().-]/.test(s)) return null;
  const hadPlus = s.startsWith("+");
  let digits = s.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (!hadPlus && digits.startsWith("0")) digits = `20${digits.slice(1)}`;
  const e164 = `+${digits}`;
  return E164_EG_MOBILE.test(e164) ? e164 : null;
}
