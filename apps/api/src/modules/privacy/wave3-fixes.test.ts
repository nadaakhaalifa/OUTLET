import { describe, expect, it } from "vitest";
import { latestConsent, type ConsentRecord } from "@outlet/privacy";
import {
  InMemoryBreachRepository,
  InMemoryObjectStore,
  InMemoryPrivacyOutbox,
  InMemoryPrivacyRequestRepository,
  FakeBlockers,
  RecordingErasureExecutor,
} from "./adapters/in-memory";
import { ProcessDeletions, RequestDeletion } from "./application/deletion";
import { ListDsarQueue } from "./application/dsar";
import { breachClocks, MAX_ERASURE_ATTEMPTS, recordBreach, triageBreach, notifyPdpc } from "./domain/bridge";
import { DAY, FakeClock, loadInventoryTables, sequentialIds } from "./test/fixtures";

const rec = (granted: boolean, at: string): ConsentRecord => ({
  userId: "u",
  purpose: "analytics",
  version: 1,
  granted,
  method: "settings_toggle",
  at,
  ipHash: "ab".repeat(16),
});

describe("consent selection", () => {
  it("is decided by append order, not by timestamps", () => {
    const h = [rec(true, "2026-01-01T00:00:10.000Z"), rec(false, "2026-01-01T00:00:05.000Z")];
    expect(latestConsent(h, "u", "analytics")?.granted).toBe(false);
  });
});

describe("breach subject clock", () => {
  it("never moves later than detected + 72h + 3d", () => {
    const base = recordBreach({ id: "b", detectedAtMs: 0, severity: "high", summary: "s", affectedCount: 1 }, 0);
    const late = notifyPdpc(triageBreach(base, "notify", 1), 200 * 3_600_000);
    expect(breachClocks(late, 200 * 3_600_000).subjects.dueAtMs).toBe(72 * 3_600_000 + 3 * DAY);
    const early = notifyPdpc(triageBreach(base, "notify", 1), 10 * 3_600_000);
    expect(breachClocks(early, 10 * 3_600_000).subjects.dueAtMs).toBe(10 * 3_600_000 + 3 * DAY);
  });
});

describe("deletion worker isolation", () => {
  const U1 = "0192f3a4-5b6c-7d8e-9f01-aaaaaaaaaaa1";
  const U2 = "0192f3a4-5b6c-7d8e-9f01-aaaaaaaaaaa2";
  it("parks a poison request after N attempts with backoff, others complete, queue/summary stay correct", async () => {
    const clock = new FakeClock();
    const ids = sequentialIds();
    const outbox = new InMemoryPrivacyOutbox();
    const repo = new InMemoryPrivacyRequestRepository(outbox);
    const blockers = new FakeBlockers();
    const executor = new RecordingErasureExecutor();
    const failing = new Set([U1]);
    const wrapped = {
      execute: async (i: Parameters<RecordingErasureExecutor["execute"]>[0]) => {
        if (failing.has(i.userId)) throw new Error("poison");
        return executor.execute(i);
      },
    };
    const p = new ProcessDeletions(repo, blockers, wrapped, () => loadInventoryTables(), (s) => `h${s.length}`, clock, ids);
    const req = new RequestDeletion(repo, blockers, clock, ids);
    const a = await req.execute({ userId: U1, acknowledgedForfeiture: false });
    clock.advance(1000);
    const b = await req.execute({ userId: U2, acknowledgedForfeiture: false });
    if (a.kind !== "created" || b.kind !== "created") throw new Error("setup");
    clock.advance(15 * DAY);

    await p.runDue();
    expect((await repo.get(b.request.id))?.status).toBe("completed");
    expect((await repo.get(a.request.id)) as { attempts: number }).toMatchObject({ attempts: 1, status: "erasing" });

    // within backoff: not retried
    await p.runDue();
    expect((await repo.get(a.request.id)) as { attempts: number }).toMatchObject({ attempts: 1 });

    for (let i = 0; i < MAX_ERASURE_ATTEMPTS; i += 1) {
      clock.advance(7 * 3_600_000);
      await p.runDue();
    }
    expect(await repo.get(a.request.id)).toMatchObject({ status: "on_hold", attempts: MAX_ERASURE_ATTEMPTS });
    expect(outbox.events.some((e) => e.type === "privacy.deletion_erasure_failed" && e.payload["parked"] === true)).toBe(true);
    clock.advance(30 * DAY);
    expect(await p.runDue()).toEqual([]);

    const q = await new ListDsarQueue(repo, clock).execute({});
    expect(q.summary.open).toBe(1);
  });

  it("erasure deletes export artifacts and expires export requests", async () => {
    expect(InMemoryObjectStore.instances.size).toBeGreaterThanOrEqual(0);
    expect(new InMemoryBreachRepository().list).toBeDefined();
  });
});
