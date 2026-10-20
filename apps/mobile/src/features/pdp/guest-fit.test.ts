import { describe, expect, it } from "vitest";
import { localFitHint } from "./model";

const sizes = [{ sku: "a", label: "S", stock: 0 }, { sku: "b", label: "M", stock: 3 }];
describe("guest fit hint", () => {
  it("matches the usual size saved on this phone, case-insensitively, with stock", () => {
    expect(localFitHint(sizes, " m ")).toEqual({ sizeLabel: "M", inStock: true });
    expect(localFitHint(sizes, "s")).toEqual({ sizeLabel: "S", inStock: false });
  });
  it("says nothing without a saved size or a match", () => {
    expect(localFitHint(sizes, null)).toBeNull();
    expect(localFitHint(sizes, "XL")).toBeNull();
  });
});
