import { describe, expect, it } from "vitest";
import { activeStepAt, anchorOf, backAction, canContinue, canJumpToPage, firstIncompletePage, formProgress, jumpTarget, primaryAction, stepOf, wizardChecklist, wizardPageOf, wizardPages } from "./formSteps";
import type { MissingItem, PublishGate } from "./model";

const gate = (missing: MissingItem[]): PublishGate => ({ canPublish: missing.length === 0, missing });

describe("form progress", () => {
  it("empty form: nothing done, photos first", () => {
    const p = formProgress(gate(["sizes", "price", "titleAr", "photos", "category", "condition", "barcode"]));
    expect(p.steps.map((s) => s.done)).toEqual([false, false, false, false, false]);
    expect(p.nextStep).toBe("photos");
    expect(p.remaining).toBe(7);
    expect(p.checklist.map((c) => c.step)).toEqual(["photos", "details", "details", "details", "price", "sizes", "sizes"]);
  });
  it("a step ticks only when none of its items are missing", () => {
    const p = formProgress(gate(["size_chart", "price"]));
    expect(p.steps.find((s) => s.id === "photos")?.done).toBe(true);
    expect(p.steps.find((s) => s.id === "details")?.done).toBe(true);
    expect(p.steps.find((s) => s.id === "price")?.done).toBe(false);
    expect(p.steps.find((s) => s.id === "sizes")?.done).toBe(false);
    expect(p.steps.find((s) => s.id === "review")?.done).toBe(false);
    expect(p.nextStep).toBe("price");
  });
  it("ready: every step including review is done", () => {
    const p = formProgress(gate([]));
    expect(p.steps.every((s) => s.done)).toBe(true);
    expect(p.canPublish).toBe(true);
    expect(p.nextStep).toBe("review");
    expect(p.remaining).toBe(0);
  });
  it("maps every gate item to a step and a scroll anchor", () => {
    expect(stepOf("uploads_pending")).toBe("photos");
    expect(stepOf("defect_photos")).toBe("details");
    expect(anchorOf("defect_photos")).toBe("defectPhotos");
    expect(anchorOf("size_chart")).toBe("sizeChart");
    expect(stepOf("barcode")).toBe("sizes");
  });
});

describe("active step from scroll", () => {
  const tops = { photos: 0, details: 400, price: 900, sizes: 1200, review: 1800 } as const;
  it("picks the last section above the offset", () => {
    expect(activeStepAt(0, tops)).toBe("photos");
    expect(activeStepAt(450, tops)).toBe("details");
    expect(activeStepAt(1300, tops)).toBe("sizes");
    expect(activeStepAt(5000, tops)).toBe("review");
  });
  it("falls back to photos with no measurements", () => expect(activeStepAt(100, {})).toBe("photos"));
});

describe("wizard pages", () => {
  const all: MissingItem[] = ["photos", "titleAr", "category", "condition", "size_chart", "price", "sizes", "barcode"];
  it("maps items to three pages and reports the first reason", () => {
    const p = wizardPages(gate(all));
    expect(p.map((x) => x.id)).toEqual(["photos", "details", "price"]);
    expect(p.map((x) => x.valid)).toEqual([false, false, false]);
    expect(p[0]?.reason).toBe("photos");
    expect(p[1]?.missing).toEqual(["titleAr", "category", "condition", "size_chart"]);
    expect(p[2]?.reason).toBe("price");
    expect(wizardPageOf("size_chart")).toBe("details");
    expect(wizardPageOf("uploads_pending")).toBe("photos");
  });
  it("continue is gated by the current page only", () => {
    expect(canContinue(gate(["photos"]), 0)).toBe(false);
    expect(canContinue(gate(["price"]), 0)).toBe(true);
    expect(canContinue(gate(["titleAr"]), 1)).toBe(false);
    expect(canContinue(gate(["titleAr"]), 2)).toBe(true);
  });
  it("last page primary is Done: publish when ready, else save draft", () => {
    expect(primaryAction(gate([]), 2)).toBe("publish");
    expect(primaryAction(gate(["sizes"]), 2)).toBe("save_draft");
    expect(primaryAction(gate([]), 0)).toBe("continue");
    expect(canContinue(gate(["sizes"]), 2)).toBe(true);
  });
  it("back steps to the previous page, and leaves from page 1 with a confirm when dirty", () => {
    expect(backAction(2, true)).toBe("previous");
    expect(backAction(1, false)).toBe("previous");
    expect(backAction(0, true)).toBe("confirm_leave");
    expect(backAction(0, false)).toBe("leave");
  });
  it("stage indicator only goes back", () => {
    expect(canJumpToPage(2, 0)).toBe(true);
    expect(canJumpToPage(1, 1)).toBe(false);
    expect(canJumpToPage(0, 2)).toBe(false);
  });
  it("checklist items jump to their page and field", () => {
    expect(jumpTarget("price")).toEqual({ page: 2, anchor: "price" });
    expect(jumpTarget("defect_photos")).toEqual({ page: 1, anchor: "defectPhotos" });
    expect(jumpTarget("photos")).toEqual({ page: 0, anchor: "photos" });
    expect(wizardChecklist(gate(["barcode", "photos", "category"])).map((c) => c.item)).toEqual(["photos", "category", "barcode"]);
    expect(firstIncompletePage(gate(["sizes"]))).toBe(2);
    expect(firstIncompletePage(gate([]))).toBe(2);
    expect(firstIncompletePage(gate(["category", "sizes"]))).toBe(1);
  });
});
