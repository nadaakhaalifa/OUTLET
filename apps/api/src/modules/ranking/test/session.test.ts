import { describe, expect, it } from "vitest";
import { FakeSessionModel } from "../index";
import { trainTransitions, type SessionEvent } from "../domain/bridge";

const ev = (ids: string[]): SessionEvent[] => ids.map((productId, i) => ({ productId, kind: "view", atMs: i * 1000 }));

describe("session next-item port (fake adapter)", () => {
  const model = trainTransitions(Array.from({ length: 10 }, () => ev(["a", "b", "c"])));
  const port = new FakeSessionModel(model);
  it("ranks the learned successor first and is deterministic", async () => {
    const a = await port.nextItemScores(ev(["a"]), ["b", "c", "z"]);
    const b = await port.nextItemScores(ev(["a"]), ["b", "c", "z"]);
    expect([...a]).toEqual([...b]);
    expect(a.get("b") ?? 0).toBeGreaterThan(a.get("z") ?? 0);
    expect(port.calls).toHaveLength(2);
  });
  it("carries no user identifier in its contract", () => {
    expect(Object.keys(port.calls[0] ?? {}).sort()).toEqual(["candidateIds", "session"]);
  });
});
