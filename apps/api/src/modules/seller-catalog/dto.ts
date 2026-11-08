import { DefectCardInput, DefectCard, DetailsInput, MoneyDto, PhotosConditionInput, LISTING_STATUSES } from "@outlet/catalog";
import { z } from "zod";
import { CursorQuery } from "../../platform/pagination.js";

/** Seller Center catalog DTOs (wire shape, snake_case). Extra operations beyond docs/api are listed in the contract additions. */

export const ProductIdParams = z.strictObject({ product_id: z.uuid() });
export type ProductIdParams = z.infer<typeof ProductIdParams>;

export const SellerProductsQuery = CursorQuery.extend({ status: z.enum(LISTING_STATUSES).optional() });
export type SellerProductsQuery = z.infer<typeof SellerProductsQuery>;

/** One price for the listing's single default variant (the wizard sells one SKU; size runs come with the variant editor). */
export const PriceSection = z.strictObject({ seller_sku: z.string().trim().min(1).max(64).optional(), price: MoneyDto });
export type PriceSection = z.infer<typeof PriceSection>;

/**
 * Autosave body. Every section present is validated in full by the catalog service (ADR-0009 rules live there); the client
 * sends a section once it is complete, so a half-typed title never reaches the server. If-Match carries `version`.
 */
export const ProductPatch = z
  .strictObject({
    condition: PhotosConditionInput.optional(),
    details: DetailsInput.optional(),
    price: PriceSection.optional(),
  })
  .refine((b) => b.condition !== undefined || b.details !== undefined || b.price !== undefined, { message: "at least one section" });
export type ProductPatch = z.infer<typeof ProductPatch>;

export const PublishBody = z.strictObject({});
export type PublishBody = z.infer<typeof PublishBody>;

export const DefectCardBody = DefectCardInput;
export type DefectCardBody = z.infer<typeof DefectCardBody>;
/** Wrapped so the audit does not mistake the card's own `items` for a list response. */
export const DefectCardResult = z.strictObject({ defect_card: DefectCard });
export type DefectCardResult = z.infer<typeof DefectCardResult>;

export const MediaUploadKind = z.enum(["product", "defect"]);
export const MediaUploadResult = z.strictObject({
  media_id: z.uuid(),
  kind: MediaUploadKind,
  status: z.enum(["ready", "rejected", "pending_scan"]),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  url: z.string(),
});
export type MediaUploadResult = z.infer<typeof MediaUploadResult>;
/** Documented body of the multipart route: field `kind` then the `file` part (the schema is not used to parse the stream). */
export const MediaUploadForm = z.strictObject({ kind: MediaUploadKind });

export const AttributeSetQuery = z.strictObject({});
export const CategoryIdParams = z.strictObject({ category_id: z.uuid() });
export const AttributeEntry = z.strictObject({
  code: z.string(),
  data_type: z.enum(["enum", "text", "number", "boolean", "size_run"]),
  unit: z.string().nullable(),
  options: z.array(z.strictObject({ code: z.string(), label_ar: z.string(), label_en: z.string().nullable() })).max(200),
  required: z.boolean(),
});
export const DefectTypeEntry = z.strictObject({ code: z.string(), label_ar: z.string(), label_en: z.string().nullable(), default_severity: z.enum(["minor", "major"]) });
/** Wizard reference data for one category: the attribute set (required flags) and the defect types a seller may pick (never the critical ones). */
export const AttributeSetResult = z.strictObject({ category_id: z.uuid(), attributes: z.array(AttributeEntry).max(100), defect_types: z.array(DefectTypeEntry).max(100) });
export type AttributeSetResult = z.infer<typeof AttributeSetResult>;
