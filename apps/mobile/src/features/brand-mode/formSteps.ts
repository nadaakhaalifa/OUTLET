/** Pure step and checklist model for the product form. Derived only from the existing publish gate (no second source of truth). */
import type { MissingItem, PublishGate } from "./model";

export type StepId = "photos" | "details" | "price" | "sizes" | "review";
export const STEP_ORDER: readonly StepId[] = ["photos", "details", "price", "sizes", "review"];

/** A field the checklist can scroll to. */
export type FieldAnchor = "photos" | "titleAr" | "category" | "condition" | "defectPhotos" | "price" | "sizes" | "sizeChart" | "barcode";

const STEP_OF: Readonly<Record<MissingItem, Exclude<StepId, "review">>> = {
  photos: "photos",
  uploads_pending: "photos",
  titleAr: "details",
  category: "details",
  condition: "details",
  defect_photos: "details",
  price: "price",
  sizes: "sizes",
  size_chart: "sizes",
  barcode: "sizes",
};

const ANCHOR_OF: Readonly<Record<MissingItem, FieldAnchor>> = {
  photos: "photos",
  uploads_pending: "photos",
  titleAr: "titleAr",
  category: "category",
  condition: "condition",
  defect_photos: "defectPhotos",
  price: "price",
  sizes: "sizes",
  size_chart: "sizeChart",
  barcode: "barcode",
};

export interface ChecklistEntry {
  readonly item: MissingItem;
  readonly step: Exclude<StepId, "review">;
  readonly anchor: FieldAnchor;
}

export interface FormProgress {
  readonly steps: readonly { readonly id: StepId; readonly done: boolean }[];
  /** What is missing, in form order (photos first), each with the field to scroll to. */
  readonly checklist: readonly ChecklistEntry[];
  readonly remaining: number;
  readonly canPublish: boolean;
  /** First step that still has something missing, or "review" when nothing is. */
  readonly nextStep: StepId;
}

export function stepOf(item: MissingItem): Exclude<StepId, "review"> { return STEP_OF[item]; }
export function anchorOf(item: MissingItem): FieldAnchor { return ANCHOR_OF[item]; }

export function formProgress(gate: PublishGate): FormProgress {
  const checklist = gate.missing
    .map((item): ChecklistEntry => ({ item, step: STEP_OF[item], anchor: ANCHOR_OF[item] }))
    .sort((a, b) => STEP_ORDER.indexOf(a.step) - STEP_ORDER.indexOf(b.step));
  const open = new Set(checklist.map((c) => c.step));
  const steps = STEP_ORDER.map((id) => ({ id, done: id === "review" ? gate.canPublish : !open.has(id) }));
  const first = steps.find((s) => !s.done && s.id !== "review");
  return { steps, checklist, remaining: gate.missing.length, canPublish: gate.canPublish, nextStep: first?.id ?? "review" };
}

/** Which step the scroll position belongs to: the last section whose top is at or above `offset`. */
export function activeStepAt(offset: number, tops: Readonly<Partial<Record<StepId, number>>>): StepId {
  let active: StepId = "photos";
  for (const id of STEP_ORDER) {
    const top = tops[id];
    if (top !== undefined && top <= offset) active = id;
  }
  return active;
}

/* ------------------------------------------------------------------ wizard (3 pages) */

export type WizardPageId = "photos" | "details" | "price";
export const WIZARD_PAGES: readonly WizardPageId[] = ["photos", "details", "price"];

/** Which wizard page owns each gate item. Size chart lives with the category it depends on (page 2). */
const WIZARD_PAGE_OF: Readonly<Record<MissingItem, WizardPageId>> = {
  photos: "photos",
  uploads_pending: "photos",
  titleAr: "details",
  category: "details",
  condition: "details",
  defect_photos: "details",
  size_chart: "details",
  price: "price",
  sizes: "price",
  barcode: "price",
};

export function wizardPageOf(item: MissingItem): WizardPageId { return WIZARD_PAGE_OF[item]; }

export interface WizardPageState {
  readonly id: WizardPageId;
  readonly index: number;
  /** Gate items that belong to this page, in the order the page shows them. */
  readonly missing: readonly MissingItem[];
  readonly valid: boolean;
  /** The first thing to fix, shown right above the primary button. */
  readonly reason: MissingItem | null;
}

const PAGE_ITEM_ORDER: readonly MissingItem[] = ["photos", "uploads_pending", "titleAr", "category", "condition", "defect_photos", "size_chart", "price", "sizes", "barcode"];

/** Per-page validity derived from the one publish gate. */
export function wizardPages(gate: PublishGate): readonly WizardPageState[] {
  return WIZARD_PAGES.map((id, index) => {
    const missing = PAGE_ITEM_ORDER.filter((i) => WIZARD_PAGE_OF[i] === id && gate.missing.includes(i));
    return { id, index, missing, valid: missing.length === 0, reason: missing[0] ?? null };
  });
}

export function pageState(gate: PublishGate, page: number): WizardPageState {
  const pages = wizardPages(gate);
  return pages[Math.min(Math.max(page, 0), pages.length - 1)] as WizardPageState;
}

export const LAST_PAGE = WIZARD_PAGES.length - 1;

/** Continue is enabled when the page is valid. The last page's primary ("Done") is always enabled: it publishes or saves a draft. */
export function canContinue(gate: PublishGate, page: number): boolean {
  return page >= LAST_PAGE ? true : pageState(gate, page).valid;
}

/** What the primary button does on this page. */
export function primaryAction(gate: PublishGate, page: number): "continue" | "publish" | "save_draft" {
  if (page < LAST_PAGE) return "continue";
  return gate.canPublish ? "publish" : "save_draft";
}

/** Back arrow: previous page, or leave (with a confirm when there are unsaved changes) from page 1. */
export function backAction(page: number, dirty: boolean): "previous" | "leave" | "confirm_leave" {
  if (page > 0) return "previous";
  return dirty ? "confirm_leave" : "leave";
}

/** Stage indicator taps go back to completed pages only (never forward past validation). */
export function canJumpToPage(current: number, target: number): boolean {
  return target >= 0 && target < current;
}

/** Checklist item -> page and field to land on. */
export function jumpTarget(item: MissingItem): { readonly page: number; readonly anchor: FieldAnchor } {
  return { page: WIZARD_PAGES.indexOf(WIZARD_PAGE_OF[item]), anchor: ANCHOR_OF[item] };
}

/** Whole-form checklist (all pages), in page order, for the review card. */
export function wizardChecklist(gate: PublishGate): readonly { readonly item: MissingItem; readonly page: number; readonly anchor: FieldAnchor }[] {
  return PAGE_ITEM_ORDER.filter((i) => gate.missing.includes(i)).map((item) => ({ item, ...jumpTarget(item) }));
}

/** First page that has something missing (for "Done" on an incomplete product), or the last page when complete. */
export function firstIncompletePage(gate: PublishGate): number {
  const p = wizardPages(gate).find((x) => !x.valid);
  return p?.index ?? LAST_PAGE;
}
