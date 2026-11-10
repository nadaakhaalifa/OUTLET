import { describe, expect, it } from "vitest";
import { AuthError, assessAge } from "../src/index.js";

const now = new Date("2026-11-08T10:00:00Z");
describe("assessAge", () => {
  it("bands around 18 and 21 on the exact birthday", () => {
    expect(assessAge("2008-11-09", now).ageBand).toBe("under_18_blocked");
    expect(assessAge("2008-11-08", now)).toMatchObject({ age: 18, ageBand: "18_20", limitedCapacity: true });
    expect(assessAge("2005-11-09", now).ageBand).toBe("18_20");
    expect(assessAge("2005-11-08", now)).toMatchObject({ age: 21, ageBand: "21_plus", limitedCapacity: false });
    expect(assessAge("2008-12-01", now).age).toBe(17);
  });
  it("rejects malformed, impossible and future dates", () => {
    for (const bad of ["x", "2000-13-01", "2001-02-30", "2027-01-01"]) {
      expect(() => assessAge(bad, now)).toThrow(AuthError);
    }
  });
});
