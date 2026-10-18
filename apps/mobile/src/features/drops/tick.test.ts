import { describe, expect, it } from "vitest";
import { FIXTURE_DROP, type DropSnapshot } from "./model";
import { clockFromServer } from "./serverClock";
import { dropRenderKey } from "./tick";

describe("dropRenderKey", () => {
  const drop: DropSnapshot = { ...FIXTURE_DROP, state: "live", endsAtMs: 10_000_000, serverNowMs: 1_000_000 };
  const clock = clockFromServer(drop.serverNowMs, 5_000);
  const base = { drop, clock, queue: { state: "idle" } as const, admittedOffsetMs: 0 };
  it("does not change between countdown ticks of the same phase", () => {
    expect(dropRenderKey({ ...base, nowMs: 5_000 })).toBe(dropRenderKey({ ...base, nowMs: 6_000 }));
  });
  it("is stable without data", () => {
    expect(dropRenderKey({ ...base, drop: null, clock: null, nowMs: 1 })).toBe("none");
  });
});
