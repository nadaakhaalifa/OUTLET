import { describe, expect, it } from "vitest";
import { FSI, PDI, isolateInterpolation } from "./bidi";
import { resources } from "./index";

function strings(node: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof node === "string") out.push([path, node]);
  else if (node !== null && typeof node === "object") for (const [k, v] of Object.entries(node)) strings(v, `${path}.${k}`, out);
}
const all = (loc: "ar" | "en"): Array<[string, string]> => { const o: Array<[string, string]> = []; strings(resources[loc], loc, o); return o; };

describe("catalog numerals", () => {
  // The formatter localises numbers at runtime (localizeDigits), so catalogs hold ASCII digits only. No allow-list.
  it("no catalog string contains Eastern Arabic-Indic or Persian digits", () => {
    const bad = [...all("ar"), ...all("en")].filter(([, v]) => /[٠-٩۰-۹٫٬]/.test(v)).map(([k]) => k);
    expect(bad).toEqual([]);
  });
});

describe("placeholder parity", () => {
  it("AR and EN carry the same interpolation placeholders for every shared key", () => {
    const en = new Map(all("en"));
    const names = (v: string) => [...v.matchAll(/\{\{\s*([\w.]+)/g)].map((m) => m[1]).sort().join(",");
    const diff = all("ar").filter(([k, v]) => { const e = en.get(`en${k.slice(2)}`); return e !== undefined && names(e) !== names(v); }).map(([k]) => k);
    expect(diff).toEqual([]);
  });
});

describe("isolateInterpolation (R8)", () => {
  it("isolates every Arabic value and leaves English alone", () => {
    expect(isolateInterpolation("Z-OUTLET", undefined, "ar")).toBe(`${FSI}Z-OUTLET${PDI}`);
    expect(isolateInterpolation(30, undefined, "ar")).toBe(`${FSI}30${PDI}`);
    expect(isolateInterpolation("Z-OUTLET", undefined, "en")).toBe("Z-OUTLET");
  });
  it("does not double-wrap and skips empty values", () => {
    const once = isolateInterpolation("x", undefined, "ar");
    expect(isolateInterpolation(once, undefined, "ar")).toBe(once);
    expect(isolateInterpolation("", undefined, "ar")).toBe("");
  });
});
