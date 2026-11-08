const STOP = new Set(["llc", "ltd", "limited", "co", "company", "corp", "corporation", "inc", "sae", "for", "and", "the", "شركه", "ش", "م", "للتجاره", "و"]);

/** Lower-case, strip diacritics and Arabic tashkeel, fold alef/ya/ta-marbuta variants, drop punctuation and legal-form words. */
export const normalizeHolderName = (raw: string): string[] => {
  const folded = raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ـ/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
  return folded.split(/\s+/).filter((t) => t.length > 0 && !STOP.has(t)).sort();
};

/** Payout rule: the bank account holder must be the seller's legal entity. Fails closed on empty names. Token-set equality. */
export const ibanNameMatches = (accountHolderName: string, legalName: string): boolean => {
  const a = normalizeHolderName(accountHolderName);
  const b = normalizeHolderName(legalName);
  return a.length > 0 && a.length === b.length && a.every((t, i) => t === b[i]);
};
