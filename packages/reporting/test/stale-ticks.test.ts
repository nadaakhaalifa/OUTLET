import { brandClient } from "@outlet/db";
import { createLogger } from "@outlet/logger";
import { describe, expect, it } from "vitest";
import { RollupConsumer, ROLLUP_REQUESTED_EVENT } from "../src/index.js";
import type { RollupService } from "../src/index.js";
import { tickWindowStart } from "../src/schemas.js";

const NOW = new Date("2026-11-10T10:10:00Z");
const min = (d: Date, w: number): number => Math.floor(d.getTime() / w);

const harness = () => {
  const ran: string[] = [];
  const q = (sql: string) => Promise.resolve({ rows: sql.startsWith("INSERT INTO inbox_processed") ? [{ message_id: "m" }] : [] });
  const worker = brandClient<"outlet_worker">({ query: q, transaction: (fn: (tx: { query: typeof q }) => Promise<unknown>) => fn({ query: q }) } as never);
  const service = { snapshotsIn: () => (ran.push("snapshots"), Promise.resolve()), runRecentIn: (_t: unknown, _m: string, days: number) => (ran.push(`days:${String(days)}`), Promise.resolve()) } as unknown as RollupService;
  return { ran, c: new RollupConsumer(worker, "EG", service, createLogger({ write: () => undefined }), () => NOW) };
};

describe("RollupConsumer stale ticks (chief review F10)", () => {
  it("skips a snapshots or sales tick older than two of its windows; runs fresh ones and nightly", async () => {
    const { ran, c } = harness();
    const ev = (payload: Record<string, unknown>) => ({ id: "e", type: ROLLUP_REQUESTED_EVENT, payload });
    expect(await c.handle(ev({ scope: "snapshots", window: `snapshots:${String(min(NOW, 60_000) - 3)}` }))).toBe("processed");
    expect(await c.handle(ev({ scope: "sales", window: `sales:${String(min(NOW, 300_000) - 3)}` }))).toBe("processed");
    expect(ran).toEqual([]);
    await c.handle(ev({ scope: "snapshots", window: `snapshots:${String(min(NOW, 60_000) - 1)}` }));
    await c.handle(ev({ scope: "sales", window: `sales:${String(min(NOW, 300_000))}` }));
    await c.handle(ev({ scope: "nightly", window: "nightly:2026-11-10" }));
    await c.handle(ev({ scope: "snapshots" })); // no window (manual tick): always runs
    expect(ran).toEqual(["snapshots", "days:3", "days:90", "snapshots"]);
  });

  it("tickWindowStart reads only a matching cadence window", () => {
    expect(tickWindowStart({ scope: "snapshots", window: "snapshots:2" })).toBe(120_000);
    expect(tickWindowStart({ scope: "sales", window: "sales:2" })).toBe(600_000);
    expect(tickWindowStart({ scope: "sales", window: "snapshots:2" })).toBeNull();
    expect(tickWindowStart({ scope: "sales", window: "sales:x" })).toBeNull();
    expect(tickWindowStart({ scope: "nightly", window: "nightly:2026-11-10" })).toBeNull();
    expect(tickWindowStart({ scope: "sales" })).toBeNull();
  });
});
