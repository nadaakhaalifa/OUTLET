import { describe, expect, it } from "vitest";
import { K_ANONYMITY_MIN, suppressSmallCells } from "./index";

describe("suppressSmallCells", () => {
  it("keeps 50 and drops 49", () => {
    const cells = [{ demandCount: 49 }, { demandCount: 50 }, { demandCount: 500 }, { demandCount: 0 }, { demandCount: 49.5 }];
    expect(K_ANONYMITY_MIN).toBe(50);
    expect(suppressSmallCells(cells).map((c) => c.demandCount)).toEqual([50, 500]);
  });
});
