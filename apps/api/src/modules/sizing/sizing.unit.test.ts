import { describe, expect, it } from "vitest";
import { ProfileCodec, CiphertextIntegrityError } from "./application/codec";
import { explain } from "./application/explain";
import { isoWeek } from "./application/recommend";
import { DevAesGcmFieldCipher } from "./adapters/in-memory";
import type { ProfileRecord } from "./domain/ports";

describe("isoWeek", () => {
  it("uses Monday based ISO weeks in UTC", () => {
    expect(isoWeek(Date.UTC(2026, 0, 1))).toBe("2026-W01"); // Thursday
    expect(isoWeek(Date.UTC(2026, 9, 11))).toBe("2026-W41"); // Sunday closes week 41
    expect(isoWeek(Date.UTC(2026, 9, 12))).toBe("2026-W42"); // Monday opens week 42
    expect(isoWeek(Date.UTC(2024, 11, 30))).toBe("2025-W01"); // belongs to next ISO year
    expect(isoWeek(Date.UTC(2021, 0, 3))).toBe("2020-W53");
  });
});

describe("ProfileCodec", () => {
  const rec = (over: Partial<ProfileRecord>): ProfileRecord => ({
    id: "p1",
    userId: "u1",
    kind: "me",
    labelEnc: new Uint8Array(),
    measurementsEnc: null,
    quickStartEnc: null,
    fitPreference: "regular",
    modestFit: false,
    version: 1,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  });

  it("round trips and the ciphertext is bound to the profile id and field", async () => {
    const codec = new ProfileCodec(new DevAesGcmFieldCipher());
    const sealed = await codec.seal("u1", "p1", {
      label: "Nada",
      measurements: { waist_cm: 70 },
      usualSize: { brandId: null, sizeLabel: "M" },
    });
    const view = await codec.open(rec(sealed));
    expect(view.label).toBe("Nada");
    expect(view.measurements).toEqual({ waist_cm: 70 });
    expect(view.usualSize).toEqual({ brandId: null, sizeLabel: "M" });
    // moved to another profile id: authentication fails, so it fails closed as an integrity fault (not an outage)
    await expect(codec.open(rec({ ...sealed, id: "p2" }))).rejects.toBeInstanceOf(CiphertextIntegrityError);
    // label ciphertext swapped into the measurements slot fails too
    await expect(codec.open(rec({ ...sealed, measurementsEnc: sealed.labelEnc }))).rejects.toBeInstanceOf(CiphertextIntegrityError);
  });

  it("never stores plaintext fields", async () => {
    const codec = new ProfileCodec(new DevAesGcmFieldCipher());
    const sealed = await codec.seal("u1", "p1", { label: "Sara", measurements: { hip_cm: 99.5 }, usualSize: null });
    const text = Buffer.from(sealed.measurementsEnc ?? new Uint8Array()).toString("latin1");
    expect(text).not.toContain("hip_cm");
    expect(sealed.quickStartEnc).toBeNull();
  });
});

describe("explain", () => {
  it("always carries Arabic text for every code", () => {
    const codes = [
      "not_sure",
      "chart_match",
      "usual_size_only",
      "between_sizes_smaller",
      "between_sizes_larger",
      "item_runs_small",
      "item_runs_large",
      "history_too_small",
      "history_too_large",
    ] as const;
    for (const code of codes) {
      const t = explain({ code, params: { size: "M", n: 22, count: 2, penalty_cm: 0 } });
      expect(t.ar.length).toBeGreaterThan(0);
      expect(t.en.length).toBeGreaterThan(0);
    }
    expect(explain({ code: "history_too_small", params: { count: 2 } }).en).toContain("2");
  });
});
