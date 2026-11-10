export const normalizeIban = (raw: string): string => raw.replace(/\s+/gu, "").toUpperCase();

const LENGTH: Readonly<Record<string, number>> = { EG: 29 };

/** ISO 13616 mod-97 check plus the country length. Defaults to Egypt (EG, 29 characters). */
export const isValidIban = (raw: string, country = "EG"): boolean => {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u.test(iban) || !iban.startsWith(country)) return false;
  const len = LENGTH[country];
  if (len !== undefined && iban.length !== len) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/gu, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
};

/** Names compare after trimming, collapsing spaces, folding case and Arabic alef/ya/ta-marbuta and diacritics. */
export const normalizeName = (s: string): string =>
  s
    .normalize("NFKC")
    .replace(/[ً-ْـ]/gu, "")
    .replace(/[أإآ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/ة/gu, "ه")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
