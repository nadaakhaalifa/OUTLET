import { LEGAL_DOCS, LEGAL_DOC_IDS, type LegalDocId } from "./generated/legal-docs";
import { parseMarkdown, type Block } from "./markdown";

export { LEGAL_DOC_IDS, type LegalDocId };
export type LegalLocale = "ar" | "en";

/** Every bundled document is a draft awaiting counsel review; the viewer must always say so. */
export const LEGAL_IS_DRAFT = true as const;

/** Links shown in Settings (shopper-facing documents, ordered). */
export const SETTINGS_LEGAL_LINKS: readonly LegalDocId[] = [
  "terms-of-service", "privacy-policy", "returns-refunds-policy", "plus-subscription-terms", "store-credit-terms",
  "gift-card-terms", "rewards-referral-terms", "review-guidelines", "prohibited-items", "cookie-tracking-notice",
  "ip-takedown-procedure", "accessibility-statement",
];

export function isLegalDocId(v: unknown): v is LegalDocId {
  return typeof v === "string" && (LEGAL_DOC_IDS as readonly string[]).includes(v);
}

export interface LegalDocView {
  readonly id: LegalDocId;
  readonly locale: LegalLocale;
  readonly blocks: readonly Block[];
  readonly draft: boolean;
}

/** Arabic is the authoritative text; English is a convenience copy. */
export function legalDocView(id: LegalDocId, locale: LegalLocale): LegalDocView {
  return { id, locale, blocks: parseMarkdown(LEGAL_DOCS[id][locale]), draft: LEGAL_IS_DRAFT };
}
