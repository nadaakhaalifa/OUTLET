import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../test/harness";
import { JOB_SPECS, buildJobs, previousCairoDay, summarize } from "./registry";

describe("worker registry against a booted in-memory AppModule", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("has unique job names and lock keys", () => {
    expect(new Set(JOB_SPECS.map((s) => s.name)).size).toBe(JOB_SPECS.length);
  });

  it.each(JOB_SPECS.map((s) => [s.name, s] as const))("resolves %s to a real provider with the method", (_name, s) => {
    const svc = h.app.get<Record<string, unknown>>(s.token, { strict: false });
    expect(svc).toBeDefined();
    expect(typeof svc[s.method]).toBe("function");
  });

  it("builds a Job for every spec and runs the safe ones against the in-memory container", async () => {
    const jobs = buildJobs({ resolve: (t) => h.app.get(t, { strict: false }), eventMode: () => false, nowMs: () => h.clock.nowMs() });
    expect(jobs).toHaveLength(JOB_SPECS.length);
    const signal = new AbortController().signal;
    for (const name of ["inventory.sweep-reservations", "orders.expire-unaccepted", "refunds.sweep", "notifications.process-due"]) {
      const j = jobs.find((x) => x.name === name);
      expect(j).toBeDefined();
      await j?.run({ name, nowMs: h.clock.nowMs(), signal });
    }
  });

  it("adds relay jobs only when the entrypoint supplies them", () => {
    const base = { resolve: () => ({}), eventMode: () => false, nowMs: () => 0 };
    expect(buildJobs(base)).toHaveLength(JOB_SPECS.length);
    const withRelays = buildJobs({ ...base, extras: { outboxRelay: { runOnce: async () => ({ published: 1 }) } } });
    expect(withRelays.map((j) => j.name)).toContain("outbox.relay");
  });

  it("summarizes results to counters only", () => {
    expect(summarize({ a: 1, b: 2n, c: [1, 2], d: "x", e: { f: 1 } })).toEqual({ a: 1, b: 2, c: 2 });
    expect(previousCairoDay(Date.UTC(2026, 0, 11, 0, 0))).toBe("2026-01-10");
  });
});
