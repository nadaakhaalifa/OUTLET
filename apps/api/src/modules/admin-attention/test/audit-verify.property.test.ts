import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InMemoryAuditChains, nodeSha256 } from "../adapters/in-memory";
import { verifyChainRows } from "../domain/audit-verify";

const payloads = fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 2, maxLength: 25 });
const build = (ps: string[], cpAt: number[] = []) => {
  const c = new InMemoryAuditChains();
  ps.forEach((p, i) => {
    c.append("c", p);
    if (cpAt.includes(i)) c.checkpoint("c");
  });
  return c;
};

describe("audit chain verification (property)", () => {
  it("an untouched chain with checkpoints has no problems", async () => {
    await fc.assert(
      fc.asyncProperty(payloads, fc.array(fc.nat(30), { maxLength: 4 }), async (ps, cps) => {
        const c = build(ps, cps);
        expect((await c.verify("c")).problems).toEqual([]);
      }),
    );
  });
  it("modifying any one row is always detected at that seq", async () => {
    await fc.assert(
      fc.asyncProperty(payloads, fc.nat(), async (ps, k) => {
        const c = build(ps);
        const seq = (k % ps.length) + 1;
        c.tamperRow("c", seq, "TAMPERED\u0000");
        const v = await c.verify("c");
        expect(v.problems.some((p) => p.seq === seq)).toBe(true);
      }),
    );
  });
  it("removing any one row is detected (gap, head removal) and tail removal is detected against a checkpoint", async () => {
    await fc.assert(
      fc.asyncProperty(payloads, fc.nat(), async (ps, k) => {
        const c = build(ps);
        const seq = (k % (ps.length - 1)) + 1; // not the tail
        c.removeRow("c", seq);
        expect((await c.verify("c")).problems.length).toBeGreaterThan(0);
      }),
    );
    await fc.assert(
      fc.asyncProperty(payloads, async (ps) => {
        const c = build(ps);
        c.checkpoint("c");
        c.removeRow("c", ps.length);
        expect((await c.verify("c")).problems.some((p) => p.problem.includes("tail truncated"))).toBe(true);
      }),
    );
  });
  it("verification is read-only: rows are identical before and after", async () => {
    const c = build(["a", "b", "c"]);
    const before = JSON.stringify(c.rows("c"));
    await c.verify("c");
    verifyChainRows(c.rows("c"), [], nodeSha256);
    expect(JSON.stringify(c.rows("c"))).toBe(before);
  });
});
