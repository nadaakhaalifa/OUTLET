import { describe, expect, it } from "vitest";
import { scenarios, sweepKillPoints } from "./chaos-scenarios";
import { createWorld } from "./world";

describe("checkout saga chaos: kill the process between every pair of steps", () => {
  for (const sc of scenarios) {
    it(`${sc.name}: every kill point converges and keeps the invariants`, async () => {
      const { points, fired } = await sweepKillPoints(sc, async () => createWorld());
      // The harness is not vacuous: nearly every kill point was actually hit.
      expect(fired).toBeGreaterThanOrEqual(Math.floor(points * 0.9));
    }, 60_000);
  }
});
