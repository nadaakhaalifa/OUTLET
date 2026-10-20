import { describe, expect, it } from "vitest";
import { normaliseBrandName } from "./name";

describe("normaliseBrandName glue words", () => {
  it("peels repeated leading and trailing 'and' so the result is a fixed point", () => {
    for (const input of ["0&&", "&&0", "& x &", "a & & b", "&", "& &"]) {
      const n = normaliseBrandName(input);
      expect(normaliseBrandName(n)).toBe(n);
    }
    expect(normaliseBrandName("0&&")).toBe("0");
    expect(normaliseBrandName("a & & b")).toBe("a and and b");
  });
});
