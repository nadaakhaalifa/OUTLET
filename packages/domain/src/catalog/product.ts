import { DomainError } from "../errors";
import type { Money } from "../money";
import { isValidGtin } from "./gtin";
import { isPriceInRange } from "./price-input";
import { checkText } from "./text";
import { CONDITIONS, DEFAULT_DEPARTMENT, DEPARTMENTS, LIMITS, type Department, type Issue, type ListingStatus, type ProductDraft, type SkuDraft } from "./types";

export class CatalogValidationError extends DomainError {
  constructor(readonly issues: readonly Issue[]) {
    super(`catalog validation failed: ${issues.map((i) => `${i.pointer}:${i.code}`).join(", ")}`);
  }
}

const SELLER_SKU = /^[A-Za-z0-9][A-Za-z0-9._\-/ ]{0,63}$/;

function variantKey(s: SkuDraft): string {
  return `${(s.color ?? "").trim().toLowerCase()}|${s.sizeLabel.trim().toLowerCase()}`;
}

/** Pure validation of a product draft. Does not touch taxonomy or uploads (those need repositories). */
export function validateProductDraft(d: ProductDraft): Issue[] {
  const issues: Issue[] = [];
  const push = (i: Issue | null): void => {
    if (i !== null) issues.push(i);
  };

  push(checkText(d.title.ar, { pointer: "/title/ar", max: LIMITS.titleMax, requireArabic: true }));
  if (d.title.en !== undefined && d.title.en.trim().length > 0) {
    push(checkText(d.title.en, { pointer: "/title/en", max: LIMITS.titleMax, requireArabic: false }));
  }
  if (d.description !== undefined) {
    push(checkText(d.description.ar, { pointer: "/description/ar", max: LIMITS.descriptionMax, requireArabic: true, allowNewlines: true }));
    if (d.description.en !== undefined && d.description.en.trim().length > 0) {
      push(
        checkText(d.description.en, { pointer: "/description/en", max: LIMITS.descriptionMax, requireArabic: false, allowNewlines: true }),
      );
    }
  }
  if (d.material !== undefined) {
    push(checkText(d.material, { pointer: "/material", max: LIMITS.materialMax, requireArabic: false }));
  }
  if (d.department !== undefined && !DEPARTMENTS.includes(d.department)) {
    issues.push({ pointer: "/department", code: "invalid_value" });
  }
  if (!CONDITIONS.includes(d.condition)) issues.push({ pointer: "/condition", code: "condition_invalid" });
  if (d.condition === "minor_defect" && d.defectPhotoUploadIds.length < 1) {
    issues.push({ pointer: "/defect_photo_upload_ids", code: "defect_photo_required" });
  }
  if (d.imageUploadIds.length > LIMITS.imagesMax) issues.push({ pointer: "/image_upload_ids", code: "image_limit_exceeded" });
  if (d.defectPhotoUploadIds.length > LIMITS.defectPhotosMax) {
    issues.push({ pointer: "/defect_photo_upload_ids", code: "image_limit_exceeded" });
  }

  if (d.skus.length < 1) issues.push({ pointer: "/skus", code: "sku_required" });
  if (d.skus.length > LIMITS.skusMax) issues.push({ pointer: "/skus", code: "too_many_skus" });
  const seen = new Set<string>();
  d.skus.slice(0, LIMITS.skusMax).forEach((s, i) => {
    const p = `/skus/${i}`;
    const label = s.sizeLabel.trim();
    if (label.length < 1 || label.length > LIMITS.sizeLabelMax) issues.push({ pointer: `${p}/size_label`, code: "size_label_invalid" });
    if (s.color !== undefined && s.color.trim().length > LIMITS.colorMax) issues.push({ pointer: `${p}/color`, code: "text_too_long" });
    if (!isPriceInRange(s.price)) issues.push({ pointer: `${p}/price`, code: "price_out_of_range" });
    if (s.gtin !== undefined && !isValidGtin(s.gtin)) issues.push({ pointer: `${p}/barcode_gtin`, code: "gtin_invalid" });
    if (s.sellerSku !== undefined && !SELLER_SKU.test(s.sellerSku)) issues.push({ pointer: `${p}/seller_sku`, code: "seller_sku_invalid" });
    if (s.initialStock !== undefined && (!Number.isInteger(s.initialStock) || s.initialStock < 0 || s.initialStock > LIMITS.stockMax)) {
      issues.push({ pointer: `${p}/initial_stock`, code: "stock_out_of_range" });
    }
    const k = variantKey(s);
    if (seen.has(k)) issues.push({ pointer: `${p}`, code: "duplicate_variant" });
    seen.add(k);
  });
  return issues;
}

export interface Sku {
  readonly id: string;
  readonly productId: string;
  readonly storeId: string;
  readonly sellerSku?: string;
  readonly gtin?: string;
  readonly sizeLabel: string;
  readonly color?: string;
  readonly price: Money;
  readonly status: "active" | "paused" | "sold_out" | "delisted";
}

export interface Product {
  readonly id: string;
  readonly storeId: string;
  readonly title: { readonly ar: string; readonly en?: string };
  readonly description?: { readonly ar: string; readonly en?: string };
  readonly categoryId: string;
  readonly brandId?: string;
  readonly condition: ProductDraft["condition"];
  /** Shopper department; `unisex` when the seller never chose one. */
  readonly department: Department;
  readonly material?: string;
  readonly imageUploadIds: readonly string[];
  readonly defectPhotoUploadIds: readonly string[];
  readonly sizeChartId?: string;
  readonly status: ListingStatus;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly publishedAtMs?: number;
  readonly skus: readonly Sku[];
}

export interface CreateProductEnv {
  readonly storeId: string;
  readonly nowMs: number;
  readonly newId: () => string;
}

function clean(s: string): string {
  return s.trim();
}

/** Creates a draft product. Throws CatalogValidationError listing every issue. */
export function createProduct(draft: ProductDraft, env: CreateProductEnv): Product {
  const issues = validateProductDraft(draft);
  if (issues.length > 0) throw new CatalogValidationError(issues);
  const id = env.newId();
  const skus: Sku[] = draft.skus.map((s) => ({
    id: env.newId(),
    productId: id,
    storeId: env.storeId,
    ...(s.sellerSku !== undefined ? { sellerSku: s.sellerSku.trim() } : {}),
    ...(s.gtin !== undefined ? { gtin: s.gtin } : {}),
    sizeLabel: clean(s.sizeLabel),
    ...(s.color !== undefined && s.color.trim().length > 0 ? { color: clean(s.color) } : {}),
    price: s.price,
    status: "active",
  }));
  return {
    id,
    storeId: env.storeId,
    title: { ar: clean(draft.title.ar), ...(draft.title.en !== undefined && draft.title.en.trim() !== "" ? { en: clean(draft.title.en) } : {}) },
    ...(draft.description !== undefined
      ? {
          description: {
            ar: clean(draft.description.ar),
            ...(draft.description.en !== undefined && draft.description.en.trim() !== "" ? { en: clean(draft.description.en) } : {}),
          },
        }
      : {}),
    categoryId: draft.categoryId,
    ...(draft.brandId !== undefined ? { brandId: draft.brandId } : {}),
    condition: draft.condition,
    department: draft.department ?? DEFAULT_DEPARTMENT,
    ...(draft.material !== undefined && draft.material.trim() !== "" ? { material: clean(draft.material) } : {}),
    imageUploadIds: [...draft.imageUploadIds],
    defectPhotoUploadIds: [...draft.defectPhotoUploadIds],
    ...(draft.sizeChartId !== undefined ? { sizeChartId: draft.sizeChartId } : {}),
    status: "draft",
    version: 1,
    createdAtMs: env.nowMs,
    updatedAtMs: env.nowMs,
    skus,
  };
}

export interface ProductPatch {
  readonly title?: ProductDraft["title"];
  readonly description?: NonNullable<ProductDraft["description"]>;
  readonly condition?: ProductDraft["condition"];
  readonly department?: Department;
  readonly material?: string;
  readonly sizeChartId?: string;
  readonly imageUploadIds?: readonly string[];
}

/** Applies content changes (not status) and re-validates the invariants. Bumps `version`. */
export function applyProductPatch(p: Product, patch: ProductPatch, nowMs: number): Product {
  const next: Product = {
    ...p,
    ...(patch.title !== undefined
      ? { title: { ar: clean(patch.title.ar), ...(patch.title.en !== undefined && patch.title.en.trim() !== "" ? { en: clean(patch.title.en) } : {}) } }
      : {}),
    ...(patch.description !== undefined
      ? {
          description: {
            ar: clean(patch.description.ar),
            ...(patch.description.en !== undefined && patch.description.en.trim() !== "" ? { en: clean(patch.description.en) } : {}),
          },
        }
      : {}),
    ...(patch.condition !== undefined ? { condition: patch.condition } : {}),
    ...(patch.department !== undefined ? { department: patch.department } : {}),
    ...(patch.material !== undefined ? { material: clean(patch.material) } : {}),
    ...(patch.sizeChartId !== undefined ? { sizeChartId: patch.sizeChartId } : {}),
    ...(patch.imageUploadIds !== undefined ? { imageUploadIds: [...patch.imageUploadIds] } : {}),
    version: p.version + 1,
    updatedAtMs: nowMs,
  };
  const draft: ProductDraft = {
    title: next.title,
    ...(next.description !== undefined ? { description: next.description } : {}),
    categoryId: next.categoryId,
    ...(next.brandId !== undefined ? { brandId: next.brandId } : {}),
    condition: next.condition,
    department: next.department,
    ...(next.material !== undefined ? { material: next.material } : {}),
    imageUploadIds: next.imageUploadIds,
    defectPhotoUploadIds: next.defectPhotoUploadIds,
    ...(next.sizeChartId !== undefined ? { sizeChartId: next.sizeChartId } : {}),
    skus: next.skus.map((s) => ({
      ...(s.sellerSku !== undefined ? { sellerSku: s.sellerSku } : {}),
      ...(s.gtin !== undefined ? { gtin: s.gtin } : {}),
      sizeLabel: s.sizeLabel,
      ...(s.color !== undefined ? { color: s.color } : {}),
      price: s.price,
    })),
  };
  const issues = validateProductDraft(draft);
  if (issues.length > 0) throw new CatalogValidationError(issues);
  return next;
}
