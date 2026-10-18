import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  BLOCKED_GATE, FetchIngestTransport, ImpressionTracker, IngestEmitter, IngestBatchWire, classify, hasForbiddenKey,
  type IngestEmitterDeps, type IngestOutcome, type IngestRequest, type IngestTransport,
} from "./index";

function harness(over: Partial<{ consent: boolean; allowed: boolean; outcomes: IngestOutcome[]; token: string | null }> = {}) {
  const state = { consent: over.consent ?? true, allowed: over.allowed ?? true, now: 1_700_000_000_000, n: 0, token: over.token === undefined ? "att" : over.token };
  const sent: IngestRequest[] = [];
  const sleeps: number[] = [];
  const outcomes = [...(over.outcomes ?? [])];
  const transport: IngestTransport = { send: async (r) => { sent.push(r); return outcomes.shift() ?? { kind: "accepted" }; } };
  const timers: { fn: () => void; ms: number }[] = [];
  const deps: IngestEmitterDeps = {
    consent: { isGranted: () => state.consent },
    gate: { isAllowed: () => state.allowed },
    transport,
    attest: { token: async () => state.token },
    clock: { now: () => new Date(state.now) },
    ids: { next: () => `id_${String((state.n += 1)).padStart(8, "0")}` },
    random: () => 0.5,
    sleep: async (ms) => { sleeps.push(ms); },
    timers: { set: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clear: () => undefined },
    platform: "ios",
  };
  return { state, sent, sleeps, timers, emitter: new IngestEmitter(deps), deps };
}
const viewed = { name: "store_viewed", properties: { store_id: "store_1", source: "feed" } } as const;

describe("consent and kill switch gating", () => {
  it("queues nothing before analytics consent", () => {
    const h = harness({ consent: false });
    expect(h.emitter.enqueue(viewed)).toBe(false);
    expect(h.emitter.queued).toBe(0);
    expect(h.timers).toHaveLength(0);
  });
  it("clears the queue on withdrawal and sends nothing afterwards", async () => {
    const h = harness();
    h.emitter.enqueue(viewed);
    expect(h.emitter.queued).toBe(1);
    h.state.consent = false;
    h.emitter.onConsentChanged();
    expect(h.emitter.queued).toBe(0);
    await h.emitter.flush();
    expect(h.sent).toHaveLength(0);
  });
  it("withdrawal during backoff aborts the retry", async () => {
    const h = harness({ outcomes: [{ kind: "retry" }] });
    const deps = { ...h.deps, sleep: async () => { h.state.consent = false; } };
    const e = new IngestEmitter(deps);
    e.enqueue(viewed);
    await e.flush();
    expect(h.sent).toHaveLength(1);
  });
  it("a blocked flag sends nothing and queues nothing", async () => {
    const h = harness({ allowed: false });
    expect(h.emitter.enqueue(viewed)).toBe(false);
    await h.emitter.flush();
    expect(h.sent).toHaveLength(0);
    const blocked = new IngestEmitter({ ...h.deps, gate: BLOCKED_GATE });
    expect(blocked.enqueue(viewed)).toBe(false);
  });
  it("flag blocked after queueing drops the queue without sending", async () => {
    const h = harness();
    h.emitter.enqueue(viewed);
    h.state.allowed = false;
    await h.emitter.flush();
    expect(h.sent).toHaveLength(0);
    expect(h.emitter.queued).toBe(0);
  });
  it("no attestation token means no request", async () => {
    const h = harness({ token: null });
    h.emitter.enqueue(viewed);
    await h.emitter.flush();
    expect(h.sent).toHaveLength(0);
    expect(h.emitter.dropped.no_attestation).toBe(1);
  });
});

describe("batching, retry, idempotency", () => {
  it("flushes at the size cap, in batches of 30", async () => {
    const h = harness();
    for (let i = 0; i < 31; i += 1) h.emitter.enqueue({ name: "store_viewed", properties: { store_id: `s${i}`, source: "feed" } });
    await h.emitter.flush();
    expect(h.sent.map((r) => r.body.events.length)).toEqual([30, 1]);
  });
  it("arms the time cap", () => {
    const h = harness();
    h.emitter.enqueue(viewed);
    expect(h.timers[0]?.ms).toBe(15_000);
  });
  it("retries with backoff and jitter, reusing the idempotency key and event ids", async () => {
    const h = harness({ outcomes: [{ kind: "retry" }, { kind: "retry" }, { kind: "accepted" }] });
    h.emitter.enqueue(viewed);
    await h.emitter.flush();
    expect(h.sent).toHaveLength(3);
    expect(new Set(h.sent.map((r) => r.idempotencyKey)).size).toBe(1);
    expect(h.sent[0]?.body).toEqual(h.sent[2]?.body);
    expect(h.sleeps).toEqual([501, 1001]);
  });
  it("gives up after max attempts", async () => {
    const h = harness({ outcomes: Array.from({ length: 9 }, () => ({ kind: "retry" as const })) });
    h.emitter.enqueue(viewed);
    await h.emitter.flush();
    expect(h.sent).toHaveLength(5);
    expect(h.emitter.dropped.gave_up).toBe(1);
  });
  it("does not retry 503 disabled or 4xx", async () => {
    for (const kind of ["disabled", "rejected"] as const) {
      const h = harness({ outcomes: [{ kind }] });
      h.emitter.enqueue(viewed);
      await h.emitter.flush();
      expect(h.sent).toHaveLength(1);
    }
  });
  it("each batch gets its own key and the payload matches the wire schema", async () => {
    const h = harness();
    for (let i = 0; i < 31; i += 1) h.emitter.enqueue({ name: "product_viewed", properties: { store_id: "s", product_id: `p${i}`, source: "search" } });
    await h.emitter.flush();
    expect(new Set(h.sent.map((r) => r.idempotencyKey)).size).toBe(2);
    for (const r of h.sent) {
      expect(IngestBatchWire.safeParse(r.body).success).toBe(true);
      expect(r.platform).toBe("ios");
      expect(r.attest).toBe("att");
    }
  });
  it("bounds the queue and drops the oldest", () => {
    const h = harness();
    h.emitter.enqueue(viewed);
    const e = new IngestEmitter({ ...h.deps, config: { maxQueue: 3, maxBatch: 50 } });
    for (let i = 0; i < 5; i += 1) e.enqueue({ name: "store_viewed", properties: { store_id: `s${i}`, source: "feed" } });
    expect(e.queued).toBe(3);
    expect(e.dropped.overflow).toBe(2);
  });
});

describe("payload safety", () => {
  it("rejects unknown keys, bad enums and forbidden keys", () => {
    const h = harness();
    const bad = [
      { name: "store_viewed", properties: { store_id: "s", source: "feed", user_id: "u" } },
      { name: "store_viewed", properties: { store_id: "s", source: "nope" } },
      { name: "product_viewed", properties: { store_id: "a@b.co", product_id: "p", source: "feed" } },
      { name: "product_impressions", properties: { surface: "feed", items: [{ product_id: "p", store_id: "s", position: 1, budget_x: 1 }] } },
      { name: "product_impressions", properties: { surface: "feed", items: [{ product_id: "p", store_id: "s", position: 1 }, { product_id: "q", store_id: "s", position: 1 }] } },
    ];
    for (const b of bad) expect(h.emitter.enqueue(b as never)).toBe(false);
    expect(h.emitter.queued).toBe(0);
  });
  it("forbidden key detector", () => {
    for (const k of ["user_id", "phone", "email", "address", "dob", "measurements", "budget_total"]) expect(hasForbiddenKey({ a: [{ [k]: 1 }] })).toBe(true);
    expect(hasForbiddenKey({ store_id: "s", product_id: "p", position: 1 })).toBe(false);
  });
  it("sent events carry only schema keys and no identity", async () => {
    const h = harness();
    h.emitter.enqueue({ name: "product_impressions", properties: { surface: "feed", items: [{ product_id: "p1", store_id: "s1", position: 0 }] } });
    await h.emitter.flush();
    const e = h.sent[0]?.body.events[0];
    expect(Object.keys(e ?? {}).sort()).toEqual(["event_id", "name", "occurred_at", "properties"]);
    expect(JSON.stringify(h.sent[0]?.body)).not.toMatch(/user|phone|email|budget|measure|pseudonym/i);
  });
});

describe("impression tracker", () => {
  const items = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ productId: `p${from + i}`, storeId: "s1", position: from + i }));
  function tracker() {
    const h = harness();
    return { h, t: new ImpressionTracker(h.emitter) };
  }
  it("needs the dwell before emitting", async () => {
    const { h, t } = tracker();
    expect(t.observe("feed", items(2), 0)).toBe(1000);
    expect(h.emitter.queued).toBe(0);
    t.settle("feed", 1000);
    expect(h.emitter.queued).toBe(1);
    await h.emitter.flush();
    expect(h.sent[0]?.body.events[0]?.properties).toMatchObject({ surface: "feed", items: [{ product_id: "p0" }, { product_id: "p1" }] });
  });
  it("an item scrolled away before the dwell never emits", () => {
    const { h, t } = tracker();
    t.observe("feed", items(1), 0);
    t.observe("feed", [], 500);
    t.settle("feed", 5000);
    expect(h.emitter.queued).toBe(0);
  });
  it("dedupes per (product, surface) per session, not across surfaces", () => {
    const { h, t } = tracker();
    t.observe("feed", items(1), 0);
    t.settle("feed", 1000);
    t.observe("feed", items(1), 2000);
    t.settle("feed", 4000);
    expect(h.emitter.queued).toBe(1);
    t.observe("search", items(1), 5000);
    t.settle("search", 6000);
    expect(h.emitter.queued).toBe(2);
    t.reset();
    t.observe("feed", items(1), 7000);
    t.settle("feed", 8000);
    expect(h.emitter.queued).toBe(3);
  });
  it("property (seeded random runs): never more than 30 impressions per surface in any 60 s window, and no duplicates", () => {
    let seed = 12345;
    const rnd = (max: number) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % max; };
    for (let run = 0; run < 300; run += 1) {
      const h = harness();
      const emitted: { at: number; id: string }[] = [];
      let now = 0;
      const emitter = { enqueue: (e: Parameters<IngestEmitter["enqueue"]>[0]) => { if (e.name === "product_impressions") for (const i of e.properties.items) emitted.push({ at: now, id: i.product_id }); return h.emitter.enqueue(e); } };
      const t = new ImpressionTracker(emitter);
      const steps = 1 + rnd(60);
      for (let k = 0; k < steps; k += 1) {
        now += rnd(4000) + 1000;
        t.observe("feed", items(1 + rnd(40), rnd(200)), now);
        now += 1000;
        t.settle("feed", now);
      }
      expect(new Set(emitted.map((e) => e.id)).size).toBe(emitted.length);
      for (const e of emitted) expect(emitted.filter((x) => x.at >= e.at && x.at < e.at + 60_000).length).toBeLessThanOrEqual(30);
    }
  });
  it("sends nothing while the flag is blocked", async () => {
    const h = harness({ allowed: false });
    const t = new ImpressionTracker(h.emitter);
    t.observe("feed", items(3), 0);
    t.settle("feed", 1000);
    await h.emitter.flush();
    expect(h.sent).toHaveLength(0);
  });
});

describe("transport", () => {
  it("sends the required headers and classifies statuses", async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const tr = new FetchIngestTransport({ baseUrl: "https://api.test/", bearer: async () => "tok", fetch: async (url, init) => { calls.push({ url, headers: init.headers, body: init.body }); return { status: 202 }; } });
    const body = { sent_at: "2026-10-16T00:00:00.000Z", events: [] };
    expect(await tr.send({ body: body as never, idempotencyKey: "k1", platform: "android", attest: "A" })).toEqual({ kind: "accepted" });
    expect(calls[0]?.url).toBe("https://api.test/v1/analytics/events");
    expect(calls[0]?.headers).toMatchObject({ "X-App-Attest": "A", "X-Client-Platform": "android", "Idempotency-Key": "k1", Authorization: "Bearer tok" });
    expect([classify(503), classify(401), classify(429), classify(500)].map((o) => o.kind)).toEqual(["disabled", "rejected", "retry", "retry"]);
  });
});

describe("module boundary", () => {
  it("does not import budget, sizing, wallet or measurement modules", () => {
    const dir = __dirname;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/from\s+"[^"]*(budget|size-profile|sizing|measure|wallet)[^"]*"/i);
    }
  });
});
