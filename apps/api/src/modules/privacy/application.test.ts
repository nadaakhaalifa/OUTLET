import { describe, expect, it } from "vitest";
import {
  FakeBlockers,
  FakeExporter,
  InMemoryBreachRepository,
  InMemoryObjectStore,
  InMemoryPrivacyOutbox,
  InMemoryPrivacyRequestRepository,
  RecordingErasureExecutor,
} from "./adapters/in-memory";
import { ExporterRegistry, ExporterRegistryError } from "./application/exporters";
import { assembleExportZip, stableJson } from "./application/bundle";
import { CancelDeletion, ErasureNotConfiguredError, GetDeletion, ProcessDeletions, RequestDeletion } from "./application/deletion";
import { BreachRegister, ListDsarQueue } from "./application/dsar";
import { ExpireExports, GetExport, ProcessExport, RequestExport } from "./application/export";
import { InventoryResolutionError, resolveInventory } from "./application/inventory";
import { crc32 } from "./application/zip";
import type { InventoryTable } from "./domain/bridge";
import { DAY, FakeClock, START_MS, sequentialIds } from "./test/fixtures";

const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

function setup(opts: { inventory?: readonly InventoryTable[] } = {}) {
  const clock = new FakeClock();
  const ids = sequentialIds();
  const outbox = new InMemoryPrivacyOutbox();
  const requests = new InMemoryPrivacyRequestRepository(outbox);
  const breaches = new InMemoryBreachRepository(outbox);
  const store = new InMemoryObjectStore(new Uint8Array(32).fill(7));
  const blockers = new FakeBlockers();
  const executor = new RecordingErasureExecutor();
  const orders = new FakeExporter({ key: "orders", tables: ["order_groups", "order_lines"] });
  const profile = new FakeExporter({ key: "profile", tables: ["users"] });
  const registry = new ExporterRegistry([orders, profile]);
  const inventory: readonly InventoryTable[] = opts.inventory ?? [
    {
      name: "users",
      storage: "platform_db",
      fields: [{ name: "email", piiClass: "P2", onErasure: "delete", retention: "account_active", dsarExport: true }],
    },
    {
      name: "order_groups",
      storage: "platform_db",
      fields: [{ name: "user_id", piiClass: "P2", onErasure: "pseudonymize", retention: "orders_tax_records", dsarExport: true }],
    },
  ];
  return {
    clock,
    outbox,
    requests,
    breaches,
    store,
    blockers,
    executor,
    orders,
    profile,
    registry,
    requestExport: new RequestExport(requests, clock, ids),
    getExport: new GetExport(requests, store, clock),
    processExport: new ProcessExport(requests, registry, store, clock, ids),
    expireExports: new ExpireExports(requests, store, clock),
    requestDeletion: new RequestDeletion(requests, blockers, clock, ids),
    cancelDeletion: new CancelDeletion(requests, clock, ids),
    getDeletion: new GetDeletion(requests),
    processDeletions: new ProcessDeletions(requests, blockers, executor, () => inventory, (s) => `h${s.length}`, clock, ids),
    queue: new ListDsarQueue(requests, clock),
    register: new BreachRegister(breaches, clock, ids),
  };
}

const types = (s: ReturnType<typeof setup>) => s.outbox.events.map((e) => e.type);

describe("export flow", () => {
  it("is idempotent per user and records the request event once", async () => {
    const s = setup();
    const a = await s.requestExport.execute({ userId: USER, locale: "ar" });
    const b = await s.requestExport.execute({ userId: USER, locale: "en" });
    expect(a.kind).toBe("created");
    expect(b.kind).toBe("existing");
    expect(b.request.id).toBe(a.request.id);
    expect(types(s)).toEqual(["privacy.export_requested"]);
  });

  it("builds a ZIP from the registry containing only the subject's rows, then serves a 24 h signed URL", async () => {
    const s = setup();
    s.orders.seed(USER, "order_groups", [{ id: "g1", total: 12_500n }]);
    s.orders.seed(OTHER, "order_groups", [{ id: "g-other", total: 1n }]);
    s.profile.seed(USER, "users", [{ email: "a@example.test" }]);
    const { request } = await s.requestExport.execute({ userId: USER, locale: "ar" });

    expect(await s.processExport.execute(request.id)).toMatchObject({ kind: "ready" });
    expect(types(s)).toEqual(["privacy.export_requested", "privacy.export_ready"]);

    s.clock.advance(60 * 60 * 1000);
    const view = await s.getExport.execute({ userId: USER, id: request.id });
    expect(view?.download?.expiresAtMs).toBe(s.clock.nowMs() + 24 * 3_600_000);
    const bytes = s.store.bytes(`exports/${USER}/${request.id}.zip`);
    expect(bytes).toBeDefined();
    const text = new TextDecoder().decode(bytes);
    for (const name of ["README.ar.txt", "README.en.txt", "manifest.json", "data/order_groups.json", "data/users.json"]) {
      expect(text).toContain(name);
    }
    expect(text).toContain('"total": "12500"');
    expect(text).toContain("a@example.test");
    expect(text).not.toContain("g-other");
  });

  it("another user's request id resolves to nothing (404 upstream)", async () => {
    const s = setup();
    const { request } = await s.requestExport.execute({ userId: USER, locale: "ar" });
    expect(await s.getExport.execute({ userId: OTHER, id: request.id })).toBeNull();
    expect(await s.getExport.execute({ userId: USER, id: "00000000-0000-4000-8000-0000000000ff" })).toBeNull();
  });

  it("retries a failing exporter and fails terminally after three attempts, with a failure event each time", async () => {
    const s = setup();
    s.orders.failWith = new Error("db down");
    const { request } = await s.requestExport.execute({ userId: USER, locale: "ar" });
    expect((await s.processExport.execute(request.id)).kind).toBe("retry");
    expect((await s.processExport.execute(request.id)).kind).toBe("retry");
    expect((await s.processExport.execute(request.id)).kind).toBe("failed");
    expect((await s.processExport.execute(request.id)).kind).toBe("skipped");
    expect(types(s).filter((t) => t === "privacy.export_failed")).toHaveLength(3);
    expect(s.store.size).toBe(0);
    const view = await s.getExport.execute({ userId: USER, id: request.id });
    expect(view?.request.status).toBe("failed");
    expect(view?.download).toBeNull();
  });

  it("two workers racing on one request: exactly one proceeds", async () => {
    const s = setup();
    const { request } = await s.requestExport.execute({ userId: USER, locale: "ar" });
    const [a, b] = await Promise.all([s.processExport.execute(request.id), s.processExport.execute(request.id)]);
    expect([a.kind, b.kind].sort()).toEqual(["ready", "skipped"]);
    expect(types(s).filter((t) => t === "privacy.export_ready")).toHaveLength(1);
  });

  it("expires the artifact after seven days and removes the object", async () => {
    const s = setup();
    const { request } = await s.requestExport.execute({ userId: USER, locale: "ar" });
    await s.processExport.runDue();
    expect(s.store.size).toBe(1);
    s.clock.advance(7 * DAY - 1);
    expect(await s.expireExports.run()).toBe(0);
    s.clock.advance(1);
    expect(await s.expireExports.run()).toBe(1);
    expect(s.store.size).toBe(0);
    const view = await s.getExport.execute({ userId: USER, id: request.id });
    expect(view).toMatchObject({ download: null, request: { status: "expired" } });
  });

  it("does not hand out a URL after the artifact window even before the sweep ran", async () => {
    const s = setup();
    const { request } = await s.requestExport.execute({ userId: USER, locale: "ar" });
    await s.processExport.runDue();
    s.clock.advance(8 * DAY);
    expect((await s.getExport.execute({ userId: USER, id: request.id }))?.download).toBeNull();
  });
});

describe("exporter registry", () => {
  it("rejects duplicate keys, double-claimed tables and undeclared output", async () => {
    const a = new FakeExporter({ key: "a", tables: ["t1"] });
    expect(() => new ExporterRegistry([a, new FakeExporter({ key: "a", tables: ["t2"] })])).toThrow(ExporterRegistryError);
    expect(() => new ExporterRegistry([a, new FakeExporter({ key: "b", tables: ["t1"] })])).toThrow(/claimed by/);
    const rogue = {
      key: "rogue",
      tables: ["t9"],
      collect: async () => ({ tables: { t9: [], secret: [{ x: 1 }] } }),
    };
    await expect(new ExporterRegistry([rogue]).collect(USER)).rejects.toThrow(/undeclared table secret/);
  });

  it("sorts tables and fills declared-but-empty ones", async () => {
    const r = new ExporterRegistry([new FakeExporter({ key: "z", tables: ["b", "a"] })]);
    expect(Object.keys((await r.collect(USER)).tables)).toEqual(["a", "b"]);
  });
});

describe("bundle", () => {
  it("serialises bigint money exactly and writes a valid stored ZIP", () => {
    expect(stableJson({ n: 9_007_199_254_740_993n })).toContain('"9007199254740993"');
    const { bytes, manifest } = assembleExportZip({
      collected: { tables: { t: [{ a: 1 }, { a: 2 }] }, exporterKeys: ["x"] },
      locale: "en",
      generatedAtMs: START_MS,
    });
    expect(manifest.tables).toEqual({ t: 2 });
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
    expect(v.getUint16(bytes.length - 22 + 10, true)).toBe(4);
    // central directory entry 0 CRC equals the CRC of README.ar.txt
    const cdOffset = v.getUint32(bytes.length - 22 + 16, true);
    const nameLen = v.getUint16(26, true);
    const dataStart = 30 + nameLen;
    const size = v.getUint32(cdOffset + 24, true);
    expect(v.getUint32(cdOffset + 16, true)).toBe(crc32(bytes.subarray(dataStart, dataStart + size)));
  });

  it("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("deletion flow", () => {
  it("blocks with exact reasons and records nothing", async () => {
    const s = setup();
    s.blockers.set(USER, { openOrders: 1, openReturns: 2 });
    const r = await s.requestDeletion.execute({ userId: USER, acknowledgedForfeiture: true });
    expect(r).toEqual({
      kind: "blocked",
      blockers: [
        { kind: "open_orders", count: 1 },
        { kind: "open_returns", count: 2 },
      ],
    });
    expect(s.outbox.events).toEqual([]);
    expect(await s.getDeletion.execute({ userId: USER })).toBeNull();
  });

  it("requires acknowledging credit forfeiture", async () => {
    const s = setup();
    s.blockers.set(USER, { storeCreditMinor: 5_000n });
    expect(await s.requestDeletion.execute({ userId: USER, acknowledgedForfeiture: false })).toEqual({
      kind: "forfeiture_ack_required",
      balanceMinor: 5_000n,
    });
    const ok = await s.requestDeletion.execute({ userId: USER, acknowledgedForfeiture: true });
    expect(ok.kind).toBe("created");
    expect(s.outbox.events[0]?.payload["forfeited_credit_minor"]).toBe("5000");
  });

  it("is idempotent while a request is open, even if blockers appear afterwards", async () => {
    const s = setup();
    const a = await s.requestDeletion.execute({ userId: USER, acknowledgedForfeiture: false });
    s.blockers.set(USER, { openOrders: 3 });
    const b = await s.requestDeletion.execute({ userId: USER, acknowledgedForfeiture: false });
    expect(a.kind).toBe("created");
    expect(b.kind).toBe("existing");
    expect(types(s)).toEqual(["privacy.deletion_requested"]);
  });

  it("cancels during cooling, then allows a fresh request", async () => {
    const s = setup();
    await s.requestDeletion.execute({ userId: USER, acknowledgedForfeiture: false });
    s.clock.advance(13 * DAY);
    expect((await s.cancelDeletion.execute({ userId: USER })).kind).toBe("cancelled");
    expect((await s.cancelDeletion.execute({ userId: USER })).kind).toBe("not_found");
    expect((await s.requestDeletion.execute({ userId: USER, acknowledgedForfeiture: false })).kind).toBe("created");
  });

  it("cannot be cancelled after cooling ended", async () => {
    const s = setup();
    await s.requestDeletion.execute({ userId: USER, acknowledgedForfeiture: false });
    s.clock.advance(14 * DAY);
    expect(await s.cancelDeletion.execute({ userId: USER })).toEqual({ kind: "not_cancellable", status: "cooling" });
  });

  it("worker skips during cooling, erases after, applies the plan and completes", async () => {
    const s = setup();
    const { request } = (await s.requestDeletion.execute({ userId: USER, acknowledgedForfeiture: false })) as {
      request: { id: string };
    };
    s.clock.advance(14 * DAY - 1);
    expect(await s.processDeletions.runDue()).toEqual([]);
    expect((await s.processDeletions.execute(request.id)).kind).toBe("skipped");
    s.clock.advance(1);
    const [res] = await s.processDeletions.runDue();
    expect(res?.kind).toBe("completed");
    expect(s.executor.calls).toHaveLength(1);
    const call = s.executor.calls[0];
    expect(call?.pseudonym.startsWith("del_")).toBe(true);
    expect(call?.pseudonym).not.toContain(USER);
    expect(call?.plan.tables.map((t) => [t.table, t.action])).toEqual([
      ["order_groups", "pseudonymise"],
      ["users", "erase"],
    ]);
    expect(types(s)).toEqual(["privacy.deletion_requested", "privacy.deletion_completed"]);
    expect((await s.processDeletions.execute(request.id)).kind).toBe("skipped");
  });

  it("an order placed during cooling parks the request on hold, then it resumes when clear", async () => {
    const s = setup();
    const { request } = (await s.requestDeletion.execute({ userId: USER, acknowledgedForfeiture: false })) as {
      request: { id: string };
    };
    s.clock.advance(14 * DAY);
    s.blockers.set(USER, { openOrders: 1 });
    expect((await s.processDeletions.execute(request.id)).kind).toBe("on_hold");
    expect((await s.processDeletions.execute(request.id)).kind).toBe("still_blocked");
    expect(s.executor.calls).toHaveLength(0);
    expect(types(s)).toContain("privacy.deletion_on_hold");
    s.blockers.set(USER, {});
    expect((await s.processDeletions.execute(request.id)).kind).toBe("completed");
    expect(s.executor.calls).toHaveLength(1);
  });

  it("a crashed erasure is resumed from the erasing state and the executor is re-run", async () => {
    const s = setup();
    const { request } = (await s.requestDeletion.execute({ userId: USER, acknowledgedForfeiture: false })) as {
      request: { id: string };
    };
    s.clock.advance(14 * DAY);
    s.executor.failNext = true;
    await expect(s.processDeletions.execute(request.id)).rejects.toThrow("erasure failed");
    expect((await s.getDeletion.execute({ userId: USER }))?.status).toBe("erasing");
    expect((await s.processDeletions.runDue())[0]?.kind).toBe("completed");
    expect(s.executor.calls).toHaveLength(2);
    expect(s.executor.calls[1]?.pseudonym).toBe(s.executor.calls[0]?.pseudonym);
  });

  it("refuses to erase against an empty inventory instead of reporting a hollow success", async () => {
    const s = setup({ inventory: [] });
    const { request } = (await s.requestDeletion.execute({ userId: USER, acknowledgedForfeiture: false })) as {
      request: { id: string };
    };
    s.clock.advance(14 * DAY);
    await expect(s.processDeletions.execute(request.id)).rejects.toThrow(ErasureNotConfiguredError);
    expect(s.executor.calls).toHaveLength(0);
  });
});

describe("DPO read models", () => {
  it("queue shows open requests with SLA state and ranks overdue first", async () => {
    const s = setup();
    await s.requestExport.execute({ userId: USER, locale: "ar" });
    s.clock.advance(31 * DAY);
    await s.requestDeletion.execute({ userId: OTHER, acknowledgedForfeiture: false });
    const q = await s.queue.execute({});
    expect(q.summary).toMatchObject({ open: 2, overdue: 1, byKind: { export: 1, delete: 1 } });
    expect(q.items[0]).toMatchObject({ kind: "export", overdue: true, readyTargetMissed: true });
    expect((await s.queue.execute({ kind: "delete" })).items).toHaveLength(1);
  });

  it("breach clocks are driven only by the injected clock", async () => {
    const s = setup();
    const v = await s.register.record({
      detectedAtMs: START_MS - 3_600_000,
      severity: "high",
      summary: "misconfigured bucket",
      affectedCount: 40,
    });
    expect(v.clocks.pdpc.dueAtMs).toBe(START_MS - 3_600_000 + 72 * 3_600_000);
    expect(v.clocks.pdpc.status).toBe("pending");
    s.clock.advance(80 * 3_600_000);
    const [listed] = await s.register.list();
    expect(listed?.clocks.pdpc.status).toBe("overdue");
    expect(listed?.clocks.triage.status).toBe("overdue");
  });

  it("walks a breach through to closure and rejects out-of-order steps", async () => {
    const s = setup();
    const { entry } = await s.register.record({
      detectedAtMs: START_MS,
      severity: "critical",
      summary: "token leak",
      affectedCount: 1,
    });
    expect((await s.register.advance(entry.id, "notify_pdpc")).kind).toBe("invalid_transition");
    expect((await s.register.advance(entry.id, "triage")).kind).toBe("invalid_transition");
    expect((await s.register.advance(entry.id, "triage", "notify")).kind).toBe("ok");
    expect((await s.register.advance(entry.id, "notify_pdpc")).kind).toBe("ok");
    expect((await s.register.advance(entry.id, "notify_subjects")).kind).toBe("ok");
    expect((await s.register.advance(entry.id, "close")).kind).toBe("ok");
    expect((await s.register.advance("00000000-0000-4000-8000-0000000000ee", "close")).kind).toBe("not_found");
  });
});

describe("inventory resolution", () => {
  it("applies table defaults, field overrides and the P0/P1 not_personal default", () => {
    const t = resolveInventory({
      tables: [
        {
          name: "t",
          defaults: { on_erasure: "pseudonymize", retention: "r", dsar_export: false },
          fields: [
            { name: "a", pii_class: "P2" },
            { name: "b", pii_class: "P2", on_erasure: "delete", dsar_export: true },
            { name: "c", pii_class: "P1", on_erasure: "retain_legal" },
          ],
        },
        { name: "u", fields: [{ name: "x", pii_class: "P0" }] },
      ],
    });
    expect(t[0]?.fields).toEqual([
      { name: "a", piiClass: "P2", onErasure: "pseudonymize", retention: "r", dsarExport: false },
      { name: "b", piiClass: "P2", onErasure: "delete", retention: "r", dsarExport: true },
      { name: "c", piiClass: "P1", onErasure: "retain_legal", retention: "r", dsarExport: false },
    ]);
    expect(t[1]?.fields[0]).toMatchObject({ onErasure: "not_personal", dsarExport: false });
  });

  it("rejects an untagged personal field", () => {
    expect(() => resolveInventory({ tables: [{ name: "t", fields: [{ name: "a", pii_class: "P3" }] }] })).toThrow(
      InventoryResolutionError,
    );
  });
});
