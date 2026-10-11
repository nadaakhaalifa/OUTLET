import { describe, expect, it } from "vitest";
import {
  InMemorySizeProfilePort, MEASUREMENT_KEYS, advance, back, collectMeasurements, crossChecks, enterValue, formatTenths, initialWizard,
  isFinished, isMeasuredLater, measureLaterProfile, parseMeasurement, quickStart, validateLabel, validateMeasurement,
} from "./model";

describe("measurement validation", () => {
  it("parses Eastern Arabic digits and decimal commas into tenths", () => {
    expect(parseMeasurement("٧٤٫٥")).toEqual({ ok: true, tenths: 745 });
    expect(parseMeasurement("74,5")).toEqual({ ok: true, tenths: 745 });
    expect(parseMeasurement("")).toEqual({ ok: false, error: "empty" });
    expect(parseMeasurement("7x")).toEqual({ ok: false, error: "notNumber" });
    expect(parseMeasurement("74.55")).toEqual({ ok: false, error: "notNumber" });
  });
  it("rejects a waist above 250 cm and accepts 250", () => {
    expect(validateMeasurement("waist", "250.1")).toEqual({ ok: false, error: "tooHigh" });
    expect(validateMeasurement("waist", "250")).toEqual({ ok: true, tenths: 2500 });
    expect(validateMeasurement("waist", "5")).toEqual({ ok: false, error: "tooLow" });
  });
  it("flags inconsistent cross-field values", () => {
    expect(crossChecks({ bust: 800, underBust: 900 })).toEqual(["underBustAboveBust"]);
    expect(crossChecks({ hip: 900, highHip: 950 })).toEqual(["highHipAboveHip"]);
    expect(crossChecks({ bust: 900, underBust: 800 })).toEqual([]);
  });
  it("formats tenths", () => {
    expect(formatTenths(745)).toBe("74.5");
    expect(formatTenths(700)).toBe("70");
  });
});

describe("guided wizard", () => {
  it("blocks on an invalid value and advances on skip or valid", () => {
    let w = enterValue(initialWizard(), "height", "30");
    w = advance(w);
    expect(w.index).toBe(0);
    expect(w.errors.height).toBe("tooLow");
    w = advance(enterValue(w, "height", "170"));
    expect(w.index).toBe(1);
    expect(w.errors.height).toBeUndefined();
    w = advance(w); // skip weight
    expect(w.index).toBe(2);
    expect(back(w).index).toBe(1);
  });
  it("finishes after the last step and collects only valid values", () => {
    let w = enterValue(initialWizard(), "height", "170");
    for (let i = 0; i < MEASUREMENT_KEYS.length; i++) w = advance(w);
    expect(isFinished(w)).toBe(true);
    expect(collectMeasurements(w).measurements).toEqual({ height: 1700 });
  });
});

describe("quick start, measure later, labels", () => {
  it("validates quick start", () => {
    expect(quickStart({ heightRaw: "170", weightRaw: "", usualSize: "M" }).errors).toEqual([]);
    expect(quickStart({ heightRaw: "400", weightRaw: "9999", usualSize: " " }).errors).toEqual(["heightInvalid", "weightInvalid", "sizeRequired"]);
  });
  it("measure later has no measurements and no DOB or photo fields", () => {
    const p = measureLaterProfile(" Sara ", "child");
    expect(p.measurements).toEqual({});
    expect(Object.keys(p).sort()).toEqual(["fitPreference", "kind", "label", "measurements", "modestFit", "usualSize"]);
    expect(isMeasuredLater({ ...p, id: "x" })).toBe(true);
  });
  it("validates label", () => {
    expect(validateLabel(" ")).toBe("required");
    expect(validateLabel("x".repeat(31))).toBe("tooLong");
    expect(validateLabel("Me")).toBeNull();
  });
});

describe("port", () => {
  it("supports multiple profiles, update and delete", async () => {
    const p = new InMemorySizeProfilePort();
    const a = await p.save(measureLaterProfile("Me", "me"));
    await p.save(measureLaterProfile("Partner", "partner"));
    await p.save({ ...a, usualSize: "L" });
    expect((await p.list()).map((x) => x.usualSize)).toEqual(["L", null]);
    await p.remove(a.id);
    expect(await p.list()).toHaveLength(1);
  });
});
