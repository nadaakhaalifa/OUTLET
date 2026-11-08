import type { Queryable } from "@outlet/db";
import { describe, expect, it } from "vitest";
import { STALENESS_SLO_MS, measureStaleness, outboxPendingSource } from "../src/index.js";

const db = (oldest: unknown, rows = true): { q: Queryable; calls: unknown[][] } => {
  const calls: unknown[][] = [];
  const q = { query: (sql: string, p: unknown[]) => { calls.push([sql, p]); return Promise.resolve({ rows: rows ? [{ oldest }] : [] }); } } as unknown as Queryable;
  return { q, calls };
};

describe("outboxPendingSource", () => {
  it("returns null when nothing pends (null aggregate)", async () => {
    expect(await outboxPendingSource(db(null).q, "m").oldestPendingOccurredAt()).toBeNull();
  });
  it("returns null when the result has no row at all", async () => {
    expect(await outboxPendingSource(db(null, false).q, "m").oldestPendingOccurredAt()).toBeNull();
  });
  it("parses a string timestamp and passes the market and event types", async () => {
    const { q, calls } = db("2026-01-01T00:00:00.000Z");
    const d = await outboxPendingSource(q, "mkt").oldestPendingOccurredAt();
    expect(d?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect((calls[0]?.[1] as unknown[])[0]).toBe("mkt");
  });
  it("accepts a Date value", async () => {
    const d = new Date("2026-02-02T00:00:00Z");
    expect((await outboxPendingSource(db(d).q, "m").oldestPendingOccurredAt())?.getTime()).toBe(d.getTime());
  });
});

describe("measureStaleness", () => {
  const now = new Date("2026-01-01T00:10:00Z");
  it("is 0 and not breached with nothing pending", async () => {
    expect(await measureStaleness({ oldestPendingOccurredAt: () => Promise.resolve(null) }, now)).toEqual({ stalenessMs: 0, breached: false });
  });
  it("breaches exactly at the SLO", async () => {
    const r = await measureStaleness({ oldestPendingOccurredAt: () => Promise.resolve(new Date(now.getTime() - STALENESS_SLO_MS)) }, now);
    expect(r).toEqual({ stalenessMs: STALENESS_SLO_MS, breached: true });
  });
  it("just under the SLO is not breached, and a future event clamps to 0", async () => {
    expect((await measureStaleness({ oldestPendingOccurredAt: () => Promise.resolve(new Date(now.getTime() - STALENESS_SLO_MS + 1)) }, now)).breached).toBe(false);
    expect((await measureStaleness({ oldestPendingOccurredAt: () => Promise.resolve(new Date(now.getTime() + 5000)) }, now)).stalenessMs).toBe(0);
  });
});
