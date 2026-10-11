import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { conserves, matchLines, planTickets, type Finding, type ReconLine } from "./index";

const lineArb = (prefix: string) =>
  fc
    .array(
      fc.record({
        key: fc.constantFrom("k1", "k2", "k3", "k4", "k5"),
        amount: fc.constantFrom(-500n, -100n, 0n + 1n, 100n, 100n, 250n, 1_000n),
        at: fc.integer({ min: 0, max: 1_000 }),
      }),
      { maxLength: 30 },
    )
    .map((rows): ReconLine[] =>
      rows.map((r, i) => ({ id: `${prefix}${String(i).padStart(3, "0")}`, key: r.key, amount: r.amount, atMs: r.at })),
    );

const shuffle = <T,>(xs: readonly T[], seed: number): T[] =>
  [...xs].map((x, i) => ({ x, k: Math.sin(seed * 31 + i * 104729) })).sort((a, b) => a.k - b.k).map((o) => o.x);

describe("matchLines properties", () => {
  it("never uses a line twice and conserves totals", () => {
    fc.assert(
      fc.property(lineArb("e"), lineArb("i"), (ext, int) => {
        const r = matchLines(ext, int);
        const extIds = [
          ...r.matched.map((m) => m.externalId),
          ...r.mismatched.map((m) => m.externalId),
          ...r.unmatchedExternal.map((l) => l.id),
          ...r.duplicateExternal.map((l) => l.id),
        ];
        const intIds = [
          ...r.matched.map((m) => m.internalId),
          ...r.mismatched.map((m) => m.internalId),
          ...r.unmatchedInternal.map((l) => l.id),
          ...r.duplicateInternal.map((l) => l.id),
        ];
        expect(new Set(extIds).size).toBe(extIds.length);
        expect(new Set(intIds).size).toBe(intIds.length);
        expect(extIds.length).toBe(ext.length);
        expect(intIds.length).toBe(int.length);
        expect([...extIds].sort()).toEqual(ext.map((l) => l.id).sort());
        expect([...intIds].sort()).toEqual(int.map((l) => l.id).sort());
        expect(conserves(r)).toBe(true);
        expect(r.totals.external).toBe(ext.reduce((a, l) => a + l.amount, 0n));
        for (const m of r.matched) expect(ext.find((l) => l.id === m.externalId)?.amount).toBe(int.find((l) => l.id === m.internalId)?.amount);
      }),
    );
  });

  it("is independent of input order", () => {
    fc.assert(
      fc.property(lineArb("e"), lineArb("i"), fc.integer(), (ext, int, seed) => {
        expect(matchLines(shuffle(ext, seed), shuffle(int, seed + 1))).toEqual(matchLines(ext, int));
      }),
    );
  });

  it("is symmetric in swapping sides: matched pairs and mismatches mirror", () => {
    fc.assert(
      fc.property(lineArb("e"), lineArb("i"), (ext, int) => {
        const a = matchLines(ext, int);
        const b = matchLines(int, ext);
        expect(b.matched.map((m) => [m.internalId, m.externalId])).toEqual(a.matched.map((m) => [m.externalId, m.internalId]));
        expect(b.unmatchedExternal.map((l) => l.id)).toEqual(a.unmatchedInternal.map((l) => l.id));
      }),
    );
  });

  it("identical sides match completely", () => {
    fc.assert(
      fc.property(lineArb("e"), (ext) => {
        const int = ext.map((l) => ({ ...l, id: `i-${l.id}` }));
        const r = matchLines(ext, int);
        expect(r.matched).toHaveLength(ext.length);
        expect(r.mismatched.length + r.unmatchedExternal.length + r.unmatchedInternal.length).toBe(0);
      }),
    );
  });
});

describe("planTickets properties", () => {
  const fArb = fc
    .array(fc.record({ k: fc.integer({ min: 0, max: 6 }), age: fc.integer({ min: 0, max: 8 * 86_400_000 }) }), { maxLength: 12 })
    .map((rows): Finding[] =>
      rows.map((r) => ({
        source: "psp_settlement",
        kind: "unmatched_internal",
        severity: "medium",
        ref: `r${r.k}`,
        lineIds: [`l${r.k}`],
        delta: 1n,
        atMs: 10 * 86_400_000 - r.age,
        dedupeKey: `d${r.k}`,
        detail: "",
      })),
    );
  it("is order independent and every finding lands in exactly one bucket by key", () => {
    fc.assert(
      fc.property(fArb, fc.integer(), (fs, seed) => {
        const now = 10 * 86_400_000;
        const a = planTickets(fs, new Map(), now);
        const b = planTickets(shuffle(fs, seed), new Map(), now);
        expect(b.opened.map((f) => f.dedupeKey)).toEqual(a.opened.map((f) => f.dedupeKey));
        expect(b.escalated.map((f) => f.dedupeKey)).toEqual(a.escalated.map((f) => f.dedupeKey));
        const keys = new Set(fs.map((f) => f.dedupeKey));
        expect(a.opened).toHaveLength(keys.size);
        // replay with the resulting statuses: nothing opens or escalates again
        const existing = new Map([...a.statusByKey].map(([k, s]) => [k, { status: s, firstSeenAtMs: 0, escalatedAtMs: s === "escalated" ? now : null }] as const));
        const again = planTickets(fs, existing, now);
        expect(again.opened).toEqual([]);
        expect(again.escalated).toEqual([]);
        expect(again.resolved).toEqual([]);
      }),
    );
  });
});
