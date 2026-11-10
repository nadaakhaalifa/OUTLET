import type { Queryable } from "@outlet/db";
import { describe, expect, it } from "vitest";
import { STALENESS_SLO_MS, engineSyncSource, measureStaleness, outboxPendingSource } from "../src/index.js";
import type { EngineSyncSource, PendingSource } from "../src/index.js";

const db = (oldest: unknown, rows = true): { q: Queryable; calls: unknown[][] } => {
  const calls: unknown[][] = [];
  const q = { query: (sql: string, p: unknown[]) => { calls.push([sql, p]); return Promise.resolve({ rows: rows ? [{ oldest }] : [] }); } } as unknown as Queryable;
  return { q, calls };
};

describe("outboxPendingSource", () => {
  it("counts dead-lettered sync events", async () => {
    const q = { query: () => Promise.resolve({ rows: [{ n: "3" }] }) } as unknown as Queryable;
    expect(await outboxPendingSource(q, "m").deadLetteredCount()).toBe(3);
    expect(await outboxPendingSource({ query: () => Promise.resolve({ rows: [] }) }, "m").deadLetteredCount()).toBe(0);
  });
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

const src = (oldest: Date | null, dlq = 0): PendingSource => ({ oldestPendingOccurredAt: () => Promise.resolve(oldest), deadLetteredCount: () => Promise.resolve(dlq) });
const eng = (configured: boolean, unsynced = 0, oldest: Date | null = null): EngineSyncSource => ({ state: () => Promise.resolve({ configured, unsyncedDocuments: unsynced, oldestUnsyncedAt: oldest }) });

describe("measureStaleness", () => {
  const now = new Date("2026-01-01T00:10:00Z");
  const ago = (ms: number): Date => new Date(now.getTime() - ms);
  it("is 0 and fresh with nothing pending and an engine in sync", async () => {
    expect(await measureStaleness(src(null), now, eng(true))).toEqual({ stalenessMs: 0, breached: false, status: "fresh", deadLettered: 0, unsyncedDocuments: 0 });
  });
  it("never says fresh while no engine is configured, even with nothing pending (the chief finding)", async () => {
    const r = await measureStaleness(src(null), now, eng(false, 7, ago(5)));
    expect(r).toMatchObject({ stalenessMs: 0, breached: false, status: "search_provider_unconfigured", unsyncedDocuments: 7 });
  });
  it("breaches exactly at the SLO", async () => {
    expect(await measureStaleness(src(ago(STALENESS_SLO_MS)), now, eng(true))).toMatchObject({ stalenessMs: STALENESS_SLO_MS, breached: true, status: "stale" });
  });
  it("just under the SLO is not breached, and a future event clamps to 0", async () => {
    expect((await measureStaleness(src(ago(STALENESS_SLO_MS - 1)), now, eng(true))).breached).toBe(false);
    expect((await measureStaleness(src(new Date(now.getTime() + 5000)), now, eng(true))).stalenessMs).toBe(0);
  });
  it("a configured engine that is behind past the SLO is stale; behind within the SLO is still fresh but reports the count", async () => {
    expect(await measureStaleness(src(null), now, eng(true, 3, ago(STALENESS_SLO_MS + 1)))).toMatchObject({ status: "stale", breached: true, unsyncedDocuments: 3 });
    expect(await measureStaleness(src(null), now, eng(true, 3, ago(1000)))).toMatchObject({ status: "fresh", stalenessMs: 1000, unsyncedDocuments: 3 });
  });
  it("an unconfigured engine's backlog age does not count as lag, but a stale event still wins over the unconfigured status", async () => {
    expect((await measureStaleness(src(null), now, eng(false, 3, ago(10 * STALENESS_SLO_MS)))).stalenessMs).toBe(0);
    expect((await measureStaleness(src(ago(STALENESS_SLO_MS)), now, eng(false))).status).toBe("stale");
  });
  it("a dead-lettered sync event makes the index stale even when nothing else pends", async () => {
    expect(await measureStaleness(src(null, 2), now, eng(true))).toMatchObject({ status: "stale", deadLettered: 2, breached: false });
  });
});

describe("engineSyncSource", () => {
  it("passes the configured flag through and parses count and oldest", async () => {
    const q = { query: () => Promise.resolve({ rows: [{ n: "4", oldest: "2026-01-01T00:00:00.000Z" }] }) } as unknown as Queryable;
    expect(await engineSyncSource(q, "m", false).state()).toEqual({ configured: false, unsyncedDocuments: 4, oldestUnsyncedAt: new Date("2026-01-01T00:00:00.000Z") });
    expect(await engineSyncSource({ query: () => Promise.resolve({ rows: [] }) }, "m", true).state()).toEqual({ configured: true, unsyncedDocuments: 0, oldestUnsyncedAt: null });
  });
});
