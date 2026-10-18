import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ForgetShopper, InMemoryAnalyticsStore, liveEpochs, type ShopperPseudonymDeriver, type SourceEvent } from "../seller-analytics";
import { FakeBlockers, InMemoryPrivacyOutbox, InMemoryPrivacyRequestRepository, RecordingErasureExecutor } from "./adapters/in-memory";
import { ProcessDeletions, RequestDeletion } from "./application/deletion";
import type { InventoryTable } from "./domain/bridge";
import type { PreErasureStepPort } from "./domain/ports";
import { DAY, FakeClock, sequentialIds } from "./test/fixtures";

const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const STORE = "00000000-0000-4000-a000-000000000001";
const PRODUCT = "00000000-0000-4000-8000-000000000010";

const INVENTORY: readonly InventoryTable[] = [
  { name: "users", storage: "platform_db", fields: [{ name: "email", piiClass: "P2", onErasure: "delete", retention: "account_active", dsarExport: true }] },
];

function setup(steps: readonly PreErasureStepPort[]) {
  const clock = new FakeClock();
  const ids = sequentialIds();
  const outbox = new InMemoryPrivacyOutbox();
  const requests = new InMemoryPrivacyRequestRepository(outbox);
  const blockers = new FakeBlockers();
  const executor = new RecordingErasureExecutor();
  return {
    clock,
    requests,
    executor,
    request: new RequestDeletion(requests, blockers, clock, ids),
    process: new ProcessDeletions(requests, blockers, executor, () => INVENTORY, (s) => `h${s.length}`, clock, ids, steps),
  };
}

async function due(s: ReturnType<typeof setup>): Promise<string> {
  const r = await s.request.execute({ userId: USER, acknowledgedForfeiture: true });
  if (r.kind !== "created") throw new Error(`expected a created request, got ${r.kind}`);
  s.clock.advance(15 * DAY);
  return r.request.id;
}

describe("privacy erasure: steps that need the user id run before the executor", () => {
  it("runs every step with the user id, in order, before any row is erased", async () => {
    const order: string[] = [];
    const s = setup([
      { name: "a", run: async (u) => void order.push(`a:${u}`) },
      { name: "b", run: async (u) => void order.push(`b:${u}`) },
    ]);
    const id = await due(s);
    const spyExecute = s.executor.execute.bind(s.executor);
    s.executor.execute = async (i) => {
      order.push("executor");
      return spyExecute(i);
    };
    expect((await s.process.execute(id)).kind).toBe("completed");
    expect(order).toEqual([`a:${USER}`, `b:${USER}`, "executor"]);
  });

  it("a failing step is retryable: the executor is not called, the request is not completed, the next attempt succeeds", async () => {
    let fail = true;
    const s = setup([{ name: "forget-shopper", run: async () => { if (fail) throw new Error("kms unavailable"); } }]);
    const id = await due(s);
    await expect(s.process.execute(id)).rejects.toThrow("kms unavailable");
    expect(s.executor.calls).toHaveLength(0);
    fail = false;
    s.clock.advance(DAY);
    const [res] = await s.process.runDue();
    expect(res?.kind).toBe("completed");
    expect(s.executor.calls).toHaveLength(1);
  });

  it("repeated failures park the request for the DPO and never erase", async () => {
    const s = setup([{ name: "forget-shopper", run: async () => { throw new Error("down"); } }]);
    const id = await due(s);
    for (let i = 0; i < 12; i += 1) {
      s.clock.advance(3 * DAY);
      await s.process.runDue();
    }
    expect(s.executor.calls).toHaveLength(0);
    expect((await s.process.execute(id)).kind).toBe("still_blocked");
  });
});

/** HMAC pseudonyms in the shape of derivePseudonymousId (packages/analytics): px_ + 32 hex, one per key version and epoch. */
const deriver = (versions: readonly string[]): ShopperPseudonymDeriver => ({
  derive: (userKey, at) => versions.map((v) => `px_${createHmac("sha256", v).update(`pseudonym:v1:${at.getUTCFullYear()}:${userKey}`).digest("hex").slice(0, 32)}`),
});

describe("H3 end to end: deletion erases the shopper's pseudonymous analytics keys before the user row", () => {
  const versions = ["key-v1", "key-v2"];
  const d = deriver(versions);
  const view = (n: number, shopperKey: string | null, at: number): SourceEvent =>
    ({ kind: "view", productId: PRODUCT, messageId: `00000000-0000-4000-8000-${String(1000 + n).padStart(12, "0")}`, occurredAtMs: at, storeId: STORE, shopperKey }) as SourceEvent;

  it("no facts row holds any pseudonym of the user afterwards; other shoppers keep theirs; a late payload with an erased key stores NULL", async () => {
    const facts = new InMemoryAnalyticsStore();
    const s = setup([]);
    const now = s.clock.nowMs() + 15 * DAY;
    const years = liveEpochs(now);
    expect(years.length).toBeGreaterThanOrEqual(3);
    const keysOf = (u: string): string[] => years.flatMap((y) => d.derive(u, new Date(Date.UTC(y, 6, 1))));
    const events: SourceEvent[] = [];
    let n = 0;
    for (const k of keysOf(USER)) events.push(view(n++, k, now - n * 1000));
    for (const k of keysOf(OTHER)) events.push(view(n++, k, now - n * 1000));
    events.push(view(n, null, now));
    await facts.ingest("c", events, now);
    expect(facts.storedShopperKeys().filter((k) => keysOf(USER).includes(k))).toHaveLength(keysOf(USER).length);

    const forget = new ForgetShopper(d, facts, { nowMs: () => now });
    const withStep = setup([{ name: "seller-analytics.forget-shopper", run: async (u) => void (await forget.execute(u)) }]);
    withStep.clock.advance(0);
    const r = await withStep.request.execute({ userId: USER, acknowledgedForfeiture: true });
    if (r.kind !== "created") throw new Error("expected created");
    withStep.clock.advance(15 * DAY);
    expect((await withStep.process.execute(r.request.id)).kind).toBe("completed");

    const stored = facts.storedShopperKeys();
    for (const k of keysOf(USER)) expect(stored).not.toContain(k);
    for (const k of keysOf(OTHER)) expect(stored).toContain(k);
    expect(stored).toHaveLength(keysOf(OTHER).length);

    // An older, unpublished outbox payload that still carries an erased key is stored with NULL.
    const late = keysOf(USER)[0] ?? "";
    await facts.ingest("c", [view(900, late, now)], now);
    expect(facts.storedShopperKeys()).not.toContain(late);
    expect((await facts.trafficTotals(STORE, { fromMs: 0, toMs: now + 1 })).productViews).toBeGreaterThan(keysOf(OTHER).length);
  });

  it("is idempotent and refuses to report success without any pseudonym key", async () => {
    const facts = new InMemoryAnalyticsStore();
    const clock = { nowMs: () => Date.UTC(2026, 9, 16) };
    const forget = new ForgetShopper(d, facts, clock);
    const first = await forget.execute(USER);
    expect(first.keys).toBe(liveEpochs(clock.nowMs()).length * versions.length);
    expect((await forget.execute(USER)).rowsNulled).toBe(0);
    await expect(new ForgetShopper({ derive: () => [] }, facts, clock).execute(USER)).rejects.toThrow(/no live pseudonym key/);
    await expect(forget.execute("")).rejects.toThrow();
  });

  it("liveEpochs covers every UTC year that overlaps the 25 month window", () => {
    expect(liveEpochs(Date.UTC(2026, 9, 16))).toEqual([2024, 2025, 2026]);
    expect(liveEpochs(Date.UTC(2027, 0, 5))).toEqual([2024, 2025, 2026, 2027]);
    expect(liveEpochs(Date.UTC(2026, 11, 31))).toEqual([2024, 2025, 2026]);
  });
});
