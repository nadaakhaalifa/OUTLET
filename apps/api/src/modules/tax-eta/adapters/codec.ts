import { z } from "zod";
import { DOCUMENT_KINDS, money, type DocumentLine, type DocumentParty, type TaxDocument } from "../domain/bridge";

const Amount = z.string().regex(/^-?\d+$/).transform((s) => BigInt(s));

const Party = z.object({
  legalNameAr: z.string(),
  legalNameEn: z.string().nullable(),
  taxRegistrationNumber: z.string().nullable(),
  commercialRegister: z.string().nullable(),
  governorate: z.string(),
  refId: z.string(),
  kind: z.enum(["business", "consumer"]),
});

const Line = z.object({
  lineType: z.string(),
  descriptionAr: z.string(),
  descriptionEn: z.string().nullable(),
  taxCategoryCode: z.string(),
  rateBps: Amount,
  net: Amount,
  vat: Amount,
  gross: Amount,
});

const Doc = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  internalId: z.string(),
  sourceRef: z.string(),
  version: z.number().int(),
  issuedAtMs: z.number().int(),
  issuer: Party,
  recipient: Party,
  lines: z.array(Line),
  totals: z.object({ net: Amount, vat: Amount, gross: Amount }),
});

/** Bigint-safe JSON: every amount travels as a decimal string. */
export function encodeDocument(d: TaxDocument): string {
  const line = (l: DocumentLine) => ({
    lineType: l.lineType,
    descriptionAr: l.descriptionAr,
    descriptionEn: l.descriptionEn,
    taxCategoryCode: l.taxCategoryCode,
    rateBps: l.rateBps.toString(),
    net: l.net.amount.toString(),
    vat: l.vat.amount.toString(),
    gross: l.gross.amount.toString(),
  });
  return JSON.stringify({
    kind: d.kind,
    internalId: d.internalId,
    sourceRef: d.sourceRef,
    version: d.version,
    issuedAtMs: d.issuedAtMs,
    issuer: d.issuer,
    recipient: d.recipient,
    lines: d.lines.map(line),
    totals: { net: d.totals.net.amount.toString(), vat: d.totals.vat.amount.toString(), gross: d.totals.gross.amount.toString() },
  });
}

export function decodeDocument(raw: unknown): TaxDocument {
  const p = Doc.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
  const party = (x: z.infer<typeof Party>): DocumentParty => ({ ...x });
  return {
    kind: p.kind,
    internalId: p.internalId,
    sourceRef: p.sourceRef,
    version: p.version,
    issuedAtMs: p.issuedAtMs,
    issuer: party(p.issuer),
    recipient: party(p.recipient),
    lines: p.lines.map(
      (l): DocumentLine => ({
        lineType: l.lineType as DocumentLine["lineType"],
        descriptionAr: l.descriptionAr,
        descriptionEn: l.descriptionEn,
        taxCategoryCode: l.taxCategoryCode,
        rateBps: l.rateBps,
        net: money(l.net),
        vat: money(l.vat),
        gross: money(l.gross),
      }),
    ),
    totals: { net: money(p.totals.net), vat: money(p.totals.vat), gross: money(p.totals.gross) },
  };
}
