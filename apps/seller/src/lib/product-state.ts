import type { ProductWire } from "../client/seller-api";
import { CONDITION_OPTIONS, EMPTY_STATE, type ConditionId, type PhotoState, type Slot, type WizardState } from "./wizard-model";

const conditionFrom = (grade: string | null | undefined, stockReason: string | null | undefined): ConditionId => {
  if (stockReason === "near_expiry") return "nearExpiry";
  return CONDITION_OPTIONS.find((o) => o.grade === grade && o.stockReason === undefined)?.id ?? "newClearance";
};

/** Wizard state for a listing loaded from the API. Photos keep their media ids (no local preview exists for them). */
export const stateFromProduct = (p: ProductWire): WizardState => {
  const photos: Partial<Record<Slot, PhotoState>> = {};
  for (const m of p.media) {
    const slot: Slot | null = m.role === "main" ? "main" : m.role === "condition" ? "defect" : m.role === "packaging" ? "packaging" : null;
    if (slot !== null && photos[slot] === undefined) photos[slot] = { mediaId: m.media.media_id, name: "" };
  }
  const item = p.defect_card?.items[0];
  const attrs: Record<string, string> = {};
  let sizes = EMPTY_STATE.sizes;
  for (const [k, v] of Object.entries(p.attributes)) {
    if (k === "size_run" && Array.isArray(v)) {
      sizes = v.flatMap((r: unknown) => {
        if (typeof r !== "object" || r === null) return [];
        const row = r as { label?: unknown; cm?: unknown };
        return typeof row.label === "string" && typeof row.cm === "number" ? [{ label: row.label, cm: String(row.cm) }] : [];
      });
      if (sizes.length === 0) sizes = EMPTY_STATE.sizes;
    } else if (typeof v === "string") attrs[k] = v;
    else if (typeof v === "boolean" || typeof v === "number") attrs[k] = String(v);
  }
  const minor = p.skus[0]?.price.amount_minor;
  const major = minor === undefined ? "" : (BigInt(minor) / 100n).toString();
  const cents = minor === undefined ? 0n : BigInt(minor) % 100n;
  return {
    ...EMPTY_STATE,
    condition: conditionFrom(p.condition_grade_code, p.stock_reason),
    categoryId: p.primary_category_id ?? "",
    photos,
    defect:
      item === undefined
        ? EMPTY_STATE.defect
        : {
            typeCode: item.defect_type_code,
            location: item.location_ar,
            severity: item.severity,
            affectsFunction: item.affects_function,
            xPct: item.hotspot_x_bp === null || item.hotspot_x_bp === undefined ? null : item.hotspot_x_bp / 100,
            yPct: item.hotspot_y_bp === null || item.hotspot_y_bp === undefined ? null : item.hotspot_y_bp / 100,
          },
    notes: p.defect_card?.summary_ar ?? "",
    name: p.title_ar ?? "",
    description: p.description_ar ?? "",
    warrantyMonths: p.warranty_months === null || p.warranty_months === undefined ? "" : String(p.warranty_months),
    warrantyKind: p.warranty_kind === "brand" ? "brand" : p.warranty_kind === "none" ? "none" : "seller",
    accessories: p.included_accessories_ar ?? "",
    attributes: attrs,
    sizes,
    price: minor === undefined ? "" : cents === 0n ? major : `${major}.${cents.toString().padStart(2, "0")}`,
  };
};
