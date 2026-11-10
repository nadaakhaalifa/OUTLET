import type { MessageKey } from "@outlet/i18n";

/** Pure wizard rules. They mirror ADR-0009 and the catalog service; the server stays the authority (it re-checks every write). */

export type Slot = "main" | "defect" | "packaging";
export type ConditionId = "newClearance" | "openBox" | "cosmeticDefect" | "refurbished" | "nearExpiry";

export interface ConditionOption {
  readonly id: ConditionId;
  readonly labelKey: MessageKey;
  readonly grade: string;
  readonly stockReason?: string;
}

const NEW_CLEARANCE: ConditionOption = { id: "newClearance", labelKey: "condition.newClearance", grade: "new_with_tags" };
export const CONDITION_OPTIONS: readonly ConditionOption[] = [
  NEW_CLEARANCE,
  { id: "openBox", labelKey: "condition.openBox", grade: "open_box" },
  { id: "cosmeticDefect", labelKey: "condition.cosmeticDefect", grade: "new_with_imperfections" },
  { id: "refurbished", labelKey: "condition.refurbished", grade: "refurbished" },
  { id: "nearExpiry", labelKey: "condition.nearExpiry", grade: "new_with_tags", stockReason: "near_expiry" },
];

/** Grades that need a defect card with at least one defect and a close-up photo (ADR-0009). */
const DEFECT_GRADES: readonly string[] = ["new_with_imperfections", "open_box", "refurbished", "pre_owned"];
export const needsDefectCard = (grade: string): boolean => DEFECT_GRADES.includes(grade);

export const conditionOf = (id: ConditionId): ConditionOption => CONDITION_OPTIONS.find((o) => o.id === id) ?? NEW_CLEARANCE;

export interface PhotoState {
  readonly mediaId: string;
  readonly name: string;
  /** data: URL of the local file; absent for photos restored from the server. */
  readonly previewUrl?: string;
}

export interface DefectState {
  readonly typeCode: string;
  readonly location: string;
  readonly severity: "minor" | "major";
  readonly affectsFunction: boolean;
  readonly xPct: number | null;
  readonly yPct: number | null;
}

export interface SizeRow {
  readonly label: string;
  readonly cm: string;
}

export interface WizardState {
  readonly condition: ConditionId;
  readonly categoryId: string;
  readonly photos: Readonly<Partial<Record<Slot, PhotoState>>>;
  readonly defect: DefectState;
  readonly notes: string;
  readonly name: string;
  readonly description: string;
  readonly warrantyMonths: string;
  readonly warrantyKind: "seller" | "brand" | "none";
  readonly accessories: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly sizes: readonly SizeRow[];
  readonly price: string;
  readonly quantity: string;
  readonly offersEnabled: boolean;
  readonly offerMinimum: string;
}

export const EMPTY_DEFECT: DefectState = { typeCode: "", location: "", severity: "minor", affectsFunction: true, xPct: null, yPct: null };

export const EMPTY_STATE: WizardState = {
  condition: "newClearance",
  categoryId: "",
  photos: {},
  defect: EMPTY_DEFECT,
  notes: "",
  name: "",
  description: "",
  warrantyMonths: "",
  warrantyKind: "seller",
  accessories: "",
  attributes: {},
  sizes: [{ label: "", cm: "" }],
  price: "",
  quantity: "",
  offersEnabled: false,
  offerMinimum: "",
};

export const MAX_NOTES = 500;
export const MAX_UPLOAD_MB = 10;
export const ACCEPTED_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

export const hasArabicLetters = (s: string): boolean => /[ء-يٮ-ۓݐ-ݿ]/u.test(s);

const EASTERN = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";
/** Latin digits and a "." decimal separator from whatever the keyboard produced (Arabic-Indic digits, "٫" or ","). */
export const normalizeDigits = (s: string): string =>
  Array.from(s.trim())
    .map((c) => {
      const e = EASTERN.indexOf(c);
      if (e >= 0) return String(e);
      const p = PERSIAN.indexOf(c);
      if (p >= 0) return String(p);
      return c === "٫" || c === "," || c === "،" ? "." : c;
    })
    .join("");

/** "1299.5" -> 129950n piastres. Integer arithmetic only; null when not a positive amount with at most 2 decimals. */
export const parsePriceMinor = (input: string): bigint | null => {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(normalizeDigits(input));
  if (m?.[1] === undefined) return null;
  const minor = BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  return minor > 0n ? minor : null;
};

export const parseMonths = (input: string): number | null => {
  const m = /^\d{1,3}$/.exec(normalizeDigits(input));
  return m === null ? null : Number(m[0]);
};

// ---------------------------------------------------------------- wire bodies (null = section not complete yet, do not send)
export interface ConditionSection {
  readonly condition_grade_code: string;
  readonly stock_reason?: string;
  readonly media: { media_id: string; role: "main" | "condition" | "packaging"; position: number }[];
}

export const conditionSection = (s: WizardState): ConditionSection | null => {
  const main = s.photos.main;
  if (main === undefined) return null;
  const opt = conditionOf(s.condition);
  const media: ConditionSection["media"] = [{ media_id: main.mediaId, role: "main", position: 0 }];
  if (needsDefectCard(opt.grade) && s.photos.defect !== undefined) media.push({ media_id: s.photos.defect.mediaId, role: "condition", position: 1 });
  if (s.photos.packaging !== undefined) media.push({ media_id: s.photos.packaging.mediaId, role: "packaging", position: 2 });
  return { condition_grade_code: opt.grade, ...(opt.stockReason === undefined ? {} : { stock_reason: opt.stockReason }), media };
};

export const sizeRun = (rows: readonly SizeRow[]): { label: string; cm: number }[] =>
  rows
    .filter((r) => r.label.trim() !== "" && /^\d{2,3}(\.\d)?$/.test(normalizeDigits(r.cm)))
    .map((r) => ({ label: r.label.trim(), cm: Number(normalizeDigits(r.cm)) }));

export interface RequiredAttribute {
  readonly code: string;
  readonly dataType: "enum" | "text" | "number" | "boolean" | "size_run";
  readonly required: boolean;
}

export const attributesPayload = (s: WizardState, defs: readonly RequiredAttribute[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    if (d.dataType === "size_run") {
      const run = sizeRun(s.sizes);
      if (run.length > 0) out[d.code] = run;
      continue;
    }
    const v = s.attributes[d.code];
    if (v === undefined || v === "") continue;
    out[d.code] = d.dataType === "boolean" ? v === "true" : d.dataType === "number" ? Number(normalizeDigits(v)) : v;
  }
  return out;
};

export const missingAttributes = (s: WizardState, defs: readonly RequiredAttribute[]): string[] => {
  const have = attributesPayload(s, defs);
  return defs.filter((d) => d.required && have[d.code] === undefined).map((d) => d.code);
};

export interface DetailsSection {
  readonly title_ar: string;
  readonly description_ar: string;
  readonly primary_category_id: string;
  readonly attributes: Record<string, unknown>;
  readonly warranty_months?: number;
  readonly warranty_kind?: "seller" | "brand" | "none";
  readonly included_accessories_ar?: string;
}

export const detailsSection = (s: WizardState, defs: readonly RequiredAttribute[]): DetailsSection | null => {
  if (s.categoryId === "" || !hasArabicLetters(s.name) || s.description.trim() === "") return null;
  const months = parseMonths(s.warrantyMonths);
  return {
    title_ar: s.name.trim(),
    description_ar: s.description.trim(),
    primary_category_id: s.categoryId,
    attributes: attributesPayload(s, defs),
    ...(months === null ? {} : { warranty_months: months, warranty_kind: s.warrantyKind }),
    ...(s.accessories.trim() === "" ? {} : { included_accessories_ar: s.accessories.trim() }),
  };
};

export interface PriceSection {
  readonly price: { amount_minor: string; currency: "EGP" };
}
export const priceSection = (s: WizardState): PriceSection | null => {
  const minor = parsePriceMinor(s.price);
  return minor === null ? null : { price: { amount_minor: minor.toString(), currency: "EGP" } };
};

export interface DefectCardBody {
  readonly summary_ar: string;
  readonly affects_function: boolean;
  readonly items: {
    defect_type_code: string;
    location_ar: string;
    severity: "minor" | "major";
    affects_function: boolean;
    photo_media_id: string;
    hotspot_x_bp?: number;
    hotspot_y_bp?: number;
  }[];
}

export const defectCardBody = (s: WizardState): DefectCardBody | null => {
  const grade = conditionOf(s.condition).grade;
  const photo = s.photos.defect;
  const d = s.defect;
  if (!needsDefectCard(grade) || photo === undefined || d.typeCode === "" || d.location.trim() === "" || s.notes.trim() === "") return null;
  const hotspot = d.xPct !== null && d.yPct !== null ? { hotspot_x_bp: Math.round(d.xPct * 100), hotspot_y_bp: Math.round(d.yPct * 100) } : {};
  return {
    summary_ar: s.notes.trim(),
    affects_function: d.affectsFunction,
    items: [{ defect_type_code: d.typeCode, location_ar: d.location.trim(), severity: d.severity, affects_function: d.affectsFunction, photo_media_id: photo.mediaId, ...hotspot }],
  };
};

// ---------------------------------------------------------------- step validation (client mirror of the server rules)
export type StepId = 1 | 2 | 3 | 4;
export const STEPS: readonly StepId[] = [1, 2, 3, 4];

export type StepProblem = "category" | "mainPhoto" | "defectPhoto" | "defectType" | "defectLocation" | "notes" | "name" | "description" | "attributes" | "price";

export const stepProblems = (step: StepId, s: WizardState, defs: readonly RequiredAttribute[]): StepProblem[] => {
  const out: StepProblem[] = [];
  const grade = conditionOf(s.condition).grade;
  if (step === 1) {
    if (s.categoryId === "") out.push("category");
    if (s.photos.main === undefined) out.push("mainPhoto");
    if (needsDefectCard(grade)) {
      if (s.photos.defect === undefined) out.push("defectPhoto");
      if (s.defect.typeCode === "") out.push("defectType");
      if (s.defect.location.trim() === "") out.push("defectLocation");
      if (s.notes.trim() === "") out.push("notes");
    }
  }
  if (step === 2) {
    if (!hasArabicLetters(s.name)) out.push("name");
    if (s.description.trim() === "") out.push("description");
    if (missingAttributes(s, defs).length > 0) out.push("attributes");
  }
  if (step === 3 && parsePriceMinor(s.price) === null) out.push("price");
  return out;
};

// ---------------------------------------------------------------- readiness checklist from the server's reasons
export interface ChecklistRow {
  readonly id: "photos" | "defect" | "condition" | "price";
  readonly labelKey: MessageKey;
  readonly done: boolean;
}

/** `reasons` are the server's activation reasons (GET readiness or the 409 body); null before a draft exists. */
export const checklistFrom = (reasons: readonly string[] | null): ChecklistRow[] => {
  const blocked = (...codes: string[]): boolean => reasons === null || codes.some((c) => reasons.includes(c));
  return [
    { id: "photos", labelKey: "seller.ready.photos", done: !blocked("MAIN_PHOTO_REQUIRED") },
    { id: "defect", labelKey: "seller.ready.defect", done: !blocked("CONDITION_PHOTO_REQUIRED") },
    { id: "condition", labelKey: "seller.ready.condition", done: !blocked("DEFECT_CARD_REQUIRED", "DEFECT_CARD_EMPTY", "DEFECT_CARD_GRADE_MISMATCH", "GRADE_DISABLED") },
    { id: "price", labelKey: "seller.ready.price", done: !blocked("NO_ACTIVE_VARIANT", "VARIANT_PRICE_INVALID") },
  ];
};

const REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  TITLE_AR_REQUIRED: "seller.reason.TITLE_AR_REQUIRED",
  TITLE_NOT_ARABIC: "seller.reason.TITLE_NOT_ARABIC",
  DESCRIPTION_AR_REQUIRED: "seller.reason.DESCRIPTION_AR_REQUIRED",
  CATEGORY_REQUIRED: "seller.reason.CATEGORY_REQUIRED",
  ATTRIBUTES_INCOMPLETE: "seller.reason.ATTRIBUTES_INCOMPLETE",
  NO_ACTIVE_VARIANT: "seller.reason.NO_ACTIVE_VARIANT",
  VARIANT_PRICE_INVALID: "seller.reason.VARIANT_PRICE_INVALID",
  GRADE_DISABLED: "seller.reason.GRADE_DISABLED",
  DEFECT_CARD_REQUIRED: "seller.reason.DEFECT_CARD_REQUIRED",
  DEFECT_CARD_EMPTY: "seller.reason.DEFECT_CARD_EMPTY",
  DEFECT_CARD_GRADE_MISMATCH: "seller.reason.DEFECT_CARD_GRADE_MISMATCH",
  MAIN_PHOTO_REQUIRED: "seller.reason.MAIN_PHOTO_REQUIRED",
  CONDITION_PHOTO_REQUIRED: "seller.reason.CONDITION_PHOTO_REQUIRED",
  SELLER_LEGAL_IDENTITY_INCOMPLETE: "seller.reason.SELLER_LEGAL_IDENTITY_INCOMPLETE",
  SELLER_NOT_ACTIVE: "seller.reason.SELLER_NOT_ACTIVE",
  STORE_NOT_ACTIVE: "seller.reason.STORE_NOT_ACTIVE",
};
export const reasonKey = (code: string): MessageKey => REASON_KEYS[code] ?? "seller.reason.unknown";

/** Which wizard step fixes a server reason (used by the "fix" links in the review step). */
export const stepForReason = (code: string): StepId => {
  if (["MAIN_PHOTO_REQUIRED", "CONDITION_PHOTO_REQUIRED", "DEFECT_CARD_REQUIRED", "DEFECT_CARD_EMPTY", "DEFECT_CARD_GRADE_MISMATCH", "GRADE_DISABLED"].includes(code)) return 1;
  if (["NO_ACTIVE_VARIANT", "VARIANT_PRICE_INVALID"].includes(code)) return 3;
  return 2;
};

export const validPhotoFile = (file: { type: string; size: number }): "type" | "size" | null =>
  !ACCEPTED_TYPES.includes(file.type) ? "type" : file.size > MAX_UPLOAD_MB * 1024 * 1024 ? "size" : null;

/** The stock on hand typed in the price step: whole units, 0 to 999999. Blank or invalid is "not set" (nothing is sent). */
export const quantityOf = (state: Pick<WizardState, "quantity">): number | null => {
  const q = state.quantity.trim();
  return /^\d{1,6}$/.test(q) ? Number(q) : null;
};
