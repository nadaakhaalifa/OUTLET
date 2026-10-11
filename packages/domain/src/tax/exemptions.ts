import { ArabicTextRequiredError, InvalidTaxInputError } from "./errors";
import { DEFAULT_VAT_BPS } from "./vat";

export const ARABIC_SCRIPT = /[\u0600-\u06FF]/;

export function requireArabic(value: string, field: string): void {
  if (value.trim().length === 0 || !ARABIC_SCRIPT.test(value)) {
    throw new ArabicTextRequiredError(`${field} must be non-empty and contain Arabic text (CPL 181/2018)`);
  }
}

export interface VatExemption {
  readonly reasonAr: string;
  readonly reasonEn: string;
  /** Statute, decision or ruling that grants the exemption. Required so every exemption is traceable. */
  readonly legalBasis: string;
  readonly effectiveFromMs: number;
  /** Exclusive. null = open ended. */
  readonly effectiveToMs: number | null;
}

export interface TaxCategory {
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly rateBps: bigint;
  readonly exemption: VatExemption | null;
  readonly version: number;
}

export const CATEGORY_CODE = /^[a-z][a-z0-9_]{1,39}$/;

/** Default categories seeded with 14% and no exemption. Admin may attach exemptions, never change the base rate. */
export const DEFAULT_TAX_CATEGORIES: readonly TaxCategory[] = [
  { code: "standard", nameAr: "سلع وخدمات خاضعة للضريبة العادية", nameEn: "Standard rated goods and services", rateBps: DEFAULT_VAT_BPS, exemption: null, version: 0 },
  { code: "marketplace_fee", nameAr: "عمولات ورسوم المنصة", nameEn: "Marketplace commission and fees", rateBps: DEFAULT_VAT_BPS, exemption: null, version: 0 },
  { code: "shipping", nameAr: "رسوم الشحن والتوصيل", nameEn: "Delivery fees", rateBps: DEFAULT_VAT_BPS, exemption: null, version: 0 },
  { code: "subscription", nameAr: "اشتراك Z-OUTLET Plus", nameEn: "Plus subscription", rateBps: DEFAULT_VAT_BPS, exemption: null, version: 0 },
  { code: "gift_card", nameAr: "بطاقات الهدايا", nameEn: "Gift cards", rateBps: DEFAULT_VAT_BPS, exemption: null, version: 0 },
];

export function exemptionActiveAt(category: TaxCategory, atMs: number): boolean {
  const e = category.exemption;
  if (e === null) return false;
  return atMs >= e.effectiveFromMs && (e.effectiveToMs === null || atMs < e.effectiveToMs);
}

/** The VAT rate that applies to this category at `atMs`: 0 when an exemption is in force. */
export function effectiveRateBps(category: TaxCategory, atMs: number): bigint {
  return exemptionActiveAt(category, atMs) ? 0n : category.rateBps;
}

export type ExemptionChange =
  | { readonly kind: "set"; readonly exemption: VatExemption; readonly reason: string }
  | { readonly kind: "clear"; readonly reason: string };

export interface ExemptionAuditEntry {
  readonly categoryCode: string;
  readonly actorId: string;
  readonly atMs: number;
  readonly action: "exemption_set" | "exemption_cleared";
  readonly reason: string;
  readonly before: VatExemption | null;
  readonly after: VatExemption | null;
  readonly versionBefore: number;
  readonly versionAfter: number;
}

/** Pure edit of a category's exemption. Always yields an audit entry; the caller persists both atomically. */
export function applyExemptionChange(
  category: TaxCategory,
  change: ExemptionChange,
  actorId: string,
  nowMs: number,
): { readonly category: TaxCategory; readonly audit: ExemptionAuditEntry } {
  if (change.reason.trim().length < 3) throw new InvalidTaxInputError("a change reason is required for the audit trail");
  if (change.kind === "set") {
    const e = change.exemption;
    requireArabic(e.reasonAr, "exemption.reasonAr");
    if (e.reasonEn.trim().length === 0) throw new InvalidTaxInputError("exemption.reasonEn is required");
    if (e.legalBasis.trim().length === 0) throw new InvalidTaxInputError("exemption.legalBasis is required");
    if (!Number.isSafeInteger(e.effectiveFromMs)) throw new InvalidTaxInputError("effectiveFromMs must be an integer");
    if (e.effectiveToMs !== null && e.effectiveToMs <= e.effectiveFromMs) {
      throw new InvalidTaxInputError("effectiveToMs must be after effectiveFromMs");
    }
  } else if (category.exemption === null) {
    throw new InvalidTaxInputError("category has no exemption to clear");
  }
  const after = change.kind === "set" ? change.exemption : null;
  const next: TaxCategory = { ...category, exemption: after, version: category.version + 1 };
  return {
    category: next,
    audit: {
      categoryCode: category.code,
      actorId,
      atMs: nowMs,
      action: change.kind === "set" ? "exemption_set" : "exemption_cleared",
      reason: change.reason.trim(),
      before: category.exemption,
      after,
      versionBefore: category.version,
      versionAfter: next.version,
    },
  };
}
