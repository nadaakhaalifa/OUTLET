import type { Condition, Department, SellerProductInputWire } from "../api/schemas";
import type { MessageKey } from "../i18n";

export interface SkuDraft {
  readonly sizeLabel: string;
  /** Whole pounds and piastres typed by the seller, e.g. "649" or "649.50". */
  readonly price: string;
  readonly stock: string;
}

export interface ProductDraft {
  readonly titleAr: string;
  readonly titleEn: string;
  readonly descriptionAr: string;
  readonly categoryId: string;
  readonly condition: Condition;
  /** Optional: the server defaults to unisex. */
  readonly department?: Department;
  readonly defectPhotoUploadIds: readonly string[];
  readonly imageUploadIds: readonly string[];
  readonly sizeChartId: string;
  readonly skus: readonly SkuDraft[];
}

export type FieldKey = "titleAr" | "descriptionAr" | "categoryId" | "defectPhotos" | "skus" | `sku.${number}.sizeLabel` | `sku.${number}.price` | `sku.${number}.stock`;

export interface FormError {
  readonly field: FieldKey;
  readonly messageKey: MessageKey;
}

const ARABIC = /[؀-ۿ]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toWesternDigits = (s: string): string =>
  s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace("٫", ".");

/** "649.5" -> 64950n, "649.50" -> 64950n, "0" -> null. No floats involved. */
export function parsePriceToPiastres(input: string): bigint | null {
  const t = toWesternDigits(input.trim());
  const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(t);
  if (m === null) return null;
  const whole = BigInt(m[1] as string);
  const frac = BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  const total = whole * 100n + frac;
  return total > 0n ? total : null;
}

export function validateProduct(d: ProductDraft): { errors: readonly FormError[]; body: SellerProductInputWire | null } {
  const errors: FormError[] = [];
  const add = (field: FieldKey, messageKey: MessageKey): void => void errors.push({ field, messageKey });

  const titleAr = d.titleAr.trim();
  if (titleAr === "") add("titleAr", "editor.error.titleArRequired");
  else if (!ARABIC.test(titleAr)) add("titleAr", "editor.error.titleArNoArabic");
  if (d.descriptionAr.trim() === "") add("descriptionAr", "editor.error.descArRequired");
  if (!UUID.test(d.categoryId)) add("categoryId", "editor.error.categoryRequired");
  if (d.condition === "minor_defect" && d.defectPhotoUploadIds.length === 0) add("defectPhotos", "editor.error.defectPhotosRequired");
  if (d.skus.length === 0) add("skus", "editor.error.noSkus");

  const skus: SellerProductInputWire["skus"][number][] = [];
  d.skus.forEach((s, i) => {
    if (s.sizeLabel.trim() === "") add(`sku.${i}.sizeLabel`, "editor.error.sizeLabelRequired");
    const p = parsePriceToPiastres(s.price);
    if (p === null) add(`sku.${i}.price`, "editor.error.priceInvalid");
    const stockText = toWesternDigits(s.stock.trim());
    const stock = stockText === "" ? 0 : /^\d{1,7}$/.test(stockText) ? Number(stockText) : null;
    if (stock === null) add(`sku.${i}.stock`, "editor.error.stockInvalid");
    if (p !== null && stock !== null && s.sizeLabel.trim() !== "") {
      skus.push({ size_label: s.sizeLabel.trim(), price: { amount: p.toString(), currency: "EGP" }, initial_stock: stock });
    }
  });
  if (errors.length > 0) return { errors, body: null };

  const titleEn = d.titleEn.trim();
  const body: SellerProductInputWire = {
    title: { ar: titleAr, ...(titleEn === "" ? {} : { en: titleEn }) },
    description: { ar: d.descriptionAr.trim() },
    category_id: d.categoryId,
    condition: d.condition,
    ...(d.department !== undefined ? { department: d.department } : {}),
    ...(d.defectPhotoUploadIds.length > 0 ? { defect_photo_upload_ids: d.defectPhotoUploadIds } : {}),
    ...(d.imageUploadIds.length > 0 ? { image_upload_ids: d.imageUploadIds } : {}),
    ...(UUID.test(d.sizeChartId) ? { size_chart_id: d.sizeChartId } : {}),
    skus,
  };
  return { errors, body };
}
