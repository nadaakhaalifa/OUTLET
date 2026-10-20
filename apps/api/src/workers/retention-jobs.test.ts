import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DISPOSITIONS, TARGETS } from "../modules/retention";
import { createHarness, type Harness } from "../test/harness";
import { buildJobs, JOB_SPECS } from "./registry";
import { RETENTION_JOB_SPECS, RETENTION_RULES } from "./retention-jobs";

describe("retention worker jobs", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("registers one nightly job per rule that has purge targets, and no more", () => {
    const withTargets = new Set(TARGETS.map((t) => t.ruleId));
    expect(new Set(RETENTION_RULES)).toEqual(withTargets);
    expect(RETENTION_JOB_SPECS).toHaveLength(withTargets.size);
    for (const s of RETENTION_JOB_SPECS) expect(JOB_SPECS).toContain(s);
    for (const d of DISPOSITIONS) if (d.targets.length === 0) expect(withTargets.has(d.ruleId)).toBe(false);
  });

  it("runs nightly in low-traffic Cairo hours (03:00-03:55), staggered", () => {
    const minutes = RETENTION_JOB_SPECS.map((s) => (s.cadence.kind === "cairo" ? s.cadence.hour * 60 + s.cadence.minute : -1));
    expect(minutes.every((m) => m >= 180 && m < 240)).toBe(true);
    expect(new Set(minutes).size).toBe(minutes.length);
  });

  it.each(RETENTION_JOB_SPECS.map((s) => [s.name, s] as const))("%s resolves its token to a provider with the method", (_n, s) => {
    const svc = h.app.get<Record<string, unknown>>(s.token, { strict: false });
    expect(typeof svc[s.method]).toBe("function");
  });

  it("every retention job runs end to end against the in-memory container", async () => {
    const jobs = buildJobs({ resolve: (t) => h.app.get(t, { strict: false }), eventMode: () => false, nowMs: () => h.clock.nowMs() });
    const signal = new AbortController().signal;
    for (const s of RETENTION_JOB_SPECS) {
      const j = jobs.find((x) => x.name === s.name);
      expect(j).toBeDefined();
      const out = await j?.run({ name: s.name, nowMs: h.clock.nowMs(), signal });
      expect(out).toMatchObject({ purged: 0, failed: 0 });
    }
  });
});
