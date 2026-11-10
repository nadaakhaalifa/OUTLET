import { brandClient } from "@outlet/db";
import type { Queryable, SqlClient } from "@outlet/db";
import { describe, expect, it } from "vitest";
import { WatchError, asStore, asWatchWorker, makeWatchEnv } from "../src/index.js";

const stmts: string[] = [];
const sql: SqlClient = {
  query: () => Promise.resolve({ rows: [] }),
  transaction: <T>(fn: (tx: Queryable) => Promise<T>) => fn({ query: (s: string) => { stmts.push(s); return Promise.resolve({ rows: [] }); } }),
};
const base = { app: brandClient<"outlet_app">(sql), worker: brandClient<"outlet_worker">(sql), marketId: "00000000-0000-4000-8000-0000000000aa", killSwitch: { isKilled: () => Promise.resolve(false) } } as never;

describe("watch env", () => {
  it("fills defaults", async () => {
    const e = makeWatchEnv(base);
    expect(e.marketCurrencies).toEqual(["EGP"]);
    expect(await e.crawlerKilled()).toBe(false);
    expect(e.now()).toBeInstanceOf(Date);
    expect(e.newId()).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("keeps explicit overrides", async () => {
    const now = new Date(0);
    const e = makeWatchEnv({ ...(base as object), marketCurrencies: ["USD"], crawlerKilled: () => Promise.resolve(true), now: () => now, newId: () => "x" } as never);
    expect(e.marketCurrencies).toEqual(["USD"]);
    expect(await e.crawlerKilled()).toBe(true);
    expect(e.now()).toBe(now);
    expect(e.newId()).toBe("x");
  });
  it("asStore with and without a user, and asWatchWorker, run their callback", async () => {
    const e = makeWatchEnv(base);
    expect(await asStore(e, "00000000-0000-4000-8000-000000000001", undefined, () => Promise.resolve(1))).toBe(1);
    expect(await asStore(e, "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", () => Promise.resolve(2))).toBe(2);
    expect(await asWatchWorker(e, () => Promise.resolve(3))).toBe(3);
    expect(stmts.length).toBeGreaterThan(0);
  });
  it("WatchError carries its code", () => {
    const w = new WatchError("forbidden", "no");
    expect(w.code).toBe("forbidden");
    expect(w.message).toBe("no");
  });
});
