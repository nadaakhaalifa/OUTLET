import { describe, expect, it } from "vitest";
import {
  INITIAL_EDITOR, MAX_POINTS, MAX_STROKES, addStroke, blockMessageKey, brushRadiusNorm, buildStroke, canRedo, canUndo, clampParams, clampView, editorReducer,
  fitRect, historyOf, isEditLocked, needsReview, pinchView, presentOf, pushVersion, redo, resetToFirst, screenToImage, simplifyPoints, undo,
} from "./editorModel";

describe("simplifyPoints", () => {
  it("keeps ends and drops near points", () => {
    const pts = Array.from({ length: 101 }, (_v, i) => ({ x: i / 10000, y: 0 }));
    const s = simplifyPoints(pts, 0.004);
    expect(s[0]).toEqual(pts[0]);
    expect(s[s.length - 1]).toEqual(pts[100]);
    expect(s.length).toBeLessThan(30);
  });
  it("caps at MAX_POINTS", () => {
    const pts = Array.from({ length: 5000 }, (_v, i) => ({ x: (i % 100) / 100, y: Math.floor(i / 100) / 50 }));
    expect(simplifyPoints(pts, 0).length).toBe(MAX_POINTS);
  });
});

describe("coordinates", () => {
  const canvas = { width: 400, height: 600 };
  const fit = fitRect(canvas, { width: 800, height: 800 });
  it("letterboxes", () => { expect(fit).toEqual({ x: 0, y: 100, width: 400, height: 400 }); });
  it("maps identity view", () => {
    expect(screenToImage({ x: 200, y: 300 }, { scale: 1, tx: 0, ty: 0 }, canvas, fit)).toEqual({ x: 0.5, y: 0.5 });
  });
  it("accounts for zoom and pan", () => {
    // 2x about the centre, panned 100 right: canvas centre (200,300) now shows image point left of centre.
    const p = screenToImage({ x: 300, y: 300 }, { scale: 2, tx: 100, ty: 0 }, canvas, fit);
    expect(p.x).toBeCloseTo(0.5, 5);
    const q = screenToImage({ x: 400, y: 300 }, { scale: 2, tx: 100, ty: 0 }, canvas, fit);
    // qx = (400 - 200 - 100) / 2 + 200 = 250 -> (250 - 0) / 400 = 0.625
    expect(q.x).toBeCloseTo(0.625, 5);
  });
  it("brush radius shrinks with zoom", () => {
    expect(brushRadiusNorm(40, 1, 400)).toBeCloseTo(0.05);
    expect(brushRadiusNorm(40, 4, 400)).toBeCloseTo(0.0125);
    expect(brushRadiusNorm(40, 0, 400)).toBe(0);
  });
  it("clamps pan and zoom", () => {
    expect(clampView({ scale: 9, tx: 5000, ty: -5000 }, canvas)).toEqual({ scale: 6, tx: 1000, ty: -1500 });
    expect(clampView({ scale: 1, tx: 50, ty: 50 }, canvas)).toEqual({ scale: 1, tx: 0, ty: 0 });
  });
  it("pinch keeps the focal point still", () => {
    const start = { scale: 1, tx: 0, ty: 0 };
    const focal = { x: 300, y: 200 };
    const before = screenToImage(focal, start, canvas, fit);
    const v = pinchView(start, 2, focal, { x: 0, y: 0 }, canvas);
    const after = screenToImage(focal, v, canvas, fit);
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
  });
});

describe("params and strokes", () => {
  it("clamps params", () => {
    expect(clampParams({ featherPx: 9, smooth: -1, edgeShiftPx: 7.4, background: "white" })).toEqual({ featherPx: 4, smooth: 0, edgeShiftPx: 3, background: "white" });
    expect(clampParams({ featherPx: Number.NaN, smooth: 0.333, edgeShiftPx: -2.6, background: "transparent" })).toEqual({ featherPx: 0, smooth: 0.33, edgeShiftPx: -3, background: "transparent" });
  });
  it("builds a clamped rounded stroke", () => {
    const s = buildStroke("erase", [{ x: -0.2, y: 0.123456 }, { x: 1.4, y: 0.5 }], 0.05);
    expect(s).toEqual({ mode: "erase", radius: 0.05, points: [[0, 0.1235], [1, 0.5]] });
    expect(buildStroke("restore", [], 0.05)).toBeNull();
  });
  it("caps strokes at 200", () => {
    let list: ReturnType<typeof addStroke>["strokes"] = [];
    const s = { mode: "erase" as const, radius: 0.02, points: [[0.1, 0.1] as const] };
    for (let i = 0; i < MAX_STROKES; i++) list = addStroke(list, s).strokes;
    const r = addStroke(list, s);
    expect(r.capped).toBe(true);
    expect(r.strokes.length).toBe(MAX_STROKES);
  });
});

describe("history", () => {
  it("undo, redo, new edit drops redo tail", () => {
    let h = historyOf([1, 2, 3]);
    expect(presentOf(h)).toBe(3);
    h = undo(undo(h));
    expect(presentOf(h)).toBe(1);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    h = pushVersion(h, 4);
    expect(h.ids).toEqual([1, 2, 4]);
    expect(canRedo(h)).toBe(false);
    expect(presentOf(resetToFirst(h))).toBe(1);
  });
  it("starts at a given present", () => { expect(presentOf(historyOf([1, 2, 3], 2))).toBe(2); });
});

describe("tool state machine", () => {
  it("draws only when editable", () => {
    let s = editorReducer(INITIAL_EDITOR, { type: "strokeStart" });
    expect(s.drawing).toBe(true);
    s = editorReducer(s, { type: "tool", tool: "restore" });
    expect(s.tool).toBe("erase");
    s = editorReducer(s, { type: "strokeEnd" });
    s = editorReducer(s, { type: "tool", tool: "move" });
    expect(editorReducer(s, { type: "strokeStart" }).drawing).toBe(false);
  });
  it("blocks drawing while applying and when locked", () => {
    const a = editorReducer(INITIAL_EDITOR, { type: "applyStart" });
    expect(editorReducer(a, { type: "strokeStart" }).drawing).toBe(false);
    expect(editorReducer(a, { type: "applyDone" }).applying).toBe(false);
    const l = editorReducer(INITIAL_EDITOR, { type: "lock" });
    expect(editorReducer(l, { type: "applyStart" }).applying).toBe(false);
  });
});

describe("blocks and review", () => {
  it("locks editing for unavailable service", () => {
    expect(isEditLocked("service_down")).toBe(true);
    expect(isEditLocked("busy")).toBe(false);
    expect(isEditLocked(null)).toBe(false);
    expect(blockMessageKey("not_configured")).toBe("unavailable");
    expect(blockMessageKey("too_large")).toBe("block.tooLarge");
    expect(blockMessageKey("failed")).toBe("failed");
  });
  it("offers review first below 85 or when unreviewed", () => {
    expect(needsReview(90, false)).toBe(true);
    expect(needsReview(84, true)).toBe(true);
    expect(needsReview(null, true)).toBe(true);
    expect(needsReview(90, true)).toBe(false);
  });
});
