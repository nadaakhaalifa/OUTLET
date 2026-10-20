import { money, type Money } from "../money";
import { DelegationRequiredError, TaxDocumentInvalidError } from "./errors";
import { effectiveRateBps, requireArabic, type TaxCategory } from "./exemptions";
import { addVatToNet, splitVatInclusive } from "./vat";

/**
 * seller_einvoice       B2B e-invoice, Z-OUTLET to a seller: commission, fees, ads, FBH services (VAT 14%).
 * shopper_ereceipt      B2C e-receipt for Z-OUTLET's OWN supplies: delivery fees it charges, Plus, gift cards.
 * seller_goods_ereceipt B2C e-receipt for SELLER goods. The seller is the supplier; Z-OUTLET may only
 *                       issue it as a service under an active delegated-signing grant (VERIFY, VR-B4-02).
 */
export const DOCUMENT_KINDS = ["seller_einvoice", "shopper_ereceipt", "seller_goods_ereceipt"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const LINE_TYPES_BY_KIND = {
  seller_einvoice: ["commission", "fee", "ads", "fbh_service"],
  shopper_ereceipt: ["delivery_fee", "plus_subscription", "gift_card_sale"],
  seller_goods_ereceipt: ["goods"],
} as const satisfies Record<DocumentKind, readonly string[]>;

export type DocumentLineType = (typeof LINE_TYPES_BY_KIND)[DocumentKind][number];

export interface DocumentParty {
  /** Arabic legal name is mandatory on every document (CPL 181/2018, spec B5). */
  readonly legalNameAr: string;
  readonly legalNameEn: string | null;
  /** Tax registration number. Mandatory for business recipients and for every issuer. */
  readonly taxRegistrationNumber: string | null;
  readonly commercialRegister: string | null;
  readonly governorate: string;
  /** Internal reference (store id or user id). Consumers are never identified on the wire beyond this. */
  readonly refId: string;
  readonly kind: "business" | "consumer";
}

export interface DocumentLine {
  readonly lineType: DocumentLineType;
  readonly descriptionAr: string;
  readonly descriptionEn: string | null;
  readonly taxCategoryCode: string;
  readonly rateBps: bigint;
  readonly net: Money;
  readonly vat: Money;
  readonly gross: Money;
}

export interface TaxDocument {
  readonly kind: DocumentKind;
  /** Deterministic, so re-issuing the same source never creates a second ETA document. */
  readonly internalId: string;
  readonly sourceRef: string;
  /** Correction counter: a rejected document is re-issued as v2 with a new internal id. */
  readonly version: number;
  readonly issuedAtMs: number;
  readonly issuer: DocumentParty;
  readonly recipient: DocumentParty;
  readonly lines: readonly DocumentLine[];
  readonly totals: { readonly net: Money; readonly vat: Money; readonly gross: Money };
}

export interface DocumentLineInput {
  readonly lineType: string;
  readonly descriptionAr: string;
  readonly descriptionEn?: string | undefined;
  readonly categoryCode: string;
  /** Piastres. Net for seller invoices (VAT added), gross (VAT-inclusive) for receipts. */
  readonly amount: Money;
}

export interface BuildDocumentInput {
  readonly kind: DocumentKind;
  readonly sourceRef: string;
  readonly version?: number | undefined;
  readonly issuedAtMs: number;
  readonly issuer: DocumentParty;
  readonly recipient: DocumentParty;
  readonly lines: readonly DocumentLineInput[];
  readonly categories: ReadonlyMap<string, TaxCategory>;
}

const SOURCE_REF = /^[A-Za-z0-9_.:-]{1,64}$/;
const PREFIX: Record<DocumentKind, string> = { seller_einvoice: "INV", shopper_ereceipt: "RCP", seller_goods_ereceipt: "GRC" };

export function internalIdFor(kind: DocumentKind, sourceRef: string, version = 1): string {
  return `${PREFIX[kind]}-${sourceRef}-v${version}`;
}

function checkParty(p: DocumentParty, role: string, needsTaxId: boolean): void {
  requireArabic(p.legalNameAr, `${role}.legalNameAr`);
  if (needsTaxId && (p.taxRegistrationNumber === null || p.taxRegistrationNumber.trim().length === 0)) {
    throw new TaxDocumentInvalidError(`${role} needs a tax registration number`);
  }
  if (p.governorate.trim().length === 0) throw new TaxDocumentInvalidError(`${role}.governorate is required`);
}

export function buildTaxDocument(input: BuildDocumentInput): TaxDocument {
  if (!SOURCE_REF.test(input.sourceRef)) throw new TaxDocumentInvalidError("sourceRef must match [A-Za-z0-9_.:-]{1,64}");
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new TaxDocumentInvalidError("version must be a positive integer");
  if (input.lines.length === 0) throw new TaxDocumentInvalidError("a document needs at least one line");
  const allowed: readonly string[] = LINE_TYPES_BY_KIND[input.kind];
  const b2b = input.kind === "seller_einvoice";
  if (b2b && input.recipient.kind !== "business") throw new TaxDocumentInvalidError("a seller e-invoice recipient must be a business");
  if (!b2b && input.recipient.kind !== "consumer") throw new TaxDocumentInvalidError("an e-receipt recipient must be a consumer");
  checkParty(input.issuer, "issuer", true);
  checkParty(input.recipient, "recipient", b2b);

  const lines: DocumentLine[] = input.lines.map((l, i) => {
    if (!allowed.includes(l.lineType)) throw new TaxDocumentInvalidError(`line ${i}: type ${l.lineType} is not allowed on ${input.kind}`);
    requireArabic(l.descriptionAr, `lines[${i}].descriptionAr`);
    if (l.amount.amount < 0n) throw new TaxDocumentInvalidError(`line ${i}: negative amounts need a credit note, not supported here`);
    const cat = input.categories.get(l.categoryCode);
    if (cat === undefined) throw new TaxDocumentInvalidError(`line ${i}: unknown tax category ${l.categoryCode}`);
    const rate = effectiveRateBps(cat, input.issuedAtMs);
    const split = b2b ? addVatToNet(l.amount, rate) : splitVatInclusive(l.amount, rate);
    return {
      lineType: l.lineType as DocumentLineType,
      descriptionAr: l.descriptionAr.trim(),
      descriptionEn: l.descriptionEn === undefined || l.descriptionEn.trim() === "" ? null : l.descriptionEn.trim(),
      taxCategoryCode: l.categoryCode,
      rateBps: rate,
      net: split.net,
      vat: split.vat,
      gross: split.gross,
    };
  });
  const sum = (f: (l: DocumentLine) => Money): Money => money(lines.reduce((s, l) => s + f(l).amount, 0n));
  const totals = { net: sum((l) => l.net), vat: sum((l) => l.vat), gross: sum((l) => l.gross) };
  if (totals.net.amount + totals.vat.amount !== totals.gross.amount) throw new TaxDocumentInvalidError("totals do not balance");
  return {
    kind: input.kind,
    internalId: internalIdFor(input.kind, input.sourceRef, version),
    sourceRef: input.sourceRef,
    version,
    issuedAtMs: input.issuedAtMs,
    issuer: input.issuer,
    recipient: input.recipient,
    lines,
    totals,
  };
}

export interface SigningDelegation {
  readonly sellerId: string;
  readonly active: boolean;
  /** Reference to the seller-uploaded signing token or HSM integration. Never the secret itself. */
  readonly signingRef: string;
}

/**
 * Seller goods receipt. The seller is the supplier and the issuer. Z-OUTLET builds it only when
 * the seller has an ACTIVE delegated-signing grant; otherwise it throws and the seller issues it
 * themselves (the default path). The shopper's order page then shows the seller's receipt id.
 */
export function buildSellerGoodsReceipt(
  input: Omit<BuildDocumentInput, "kind">,
  delegation: SigningDelegation | null,
): TaxDocument {
  if (delegation === null || !delegation.active || delegation.sellerId !== input.issuer.refId) {
    throw new DelegationRequiredError("an active delegated-signing grant from the seller is required to issue goods e-receipts");
  }
  if (input.issuer.kind !== "business") throw new TaxDocumentInvalidError("the goods supplier must be the seller business");
  return buildTaxDocument({ ...input, kind: "seller_goods_ereceipt" });
}
