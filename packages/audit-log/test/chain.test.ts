import fc from "fast-check";
import { uuidv7 } from "@outlet/ids";
import { describe, expect, it } from "vitest";
import {
  AuditChain, InMemoryAuditStore, canonicalJson, verifyChain,
  type AuditEntry, type AuditEntryInput,
} from "../src/index.js";

const base: AuditEntryInput = {
  marketId: "EG", actorType: "staff", actorId: "a1", action: "refund.approved",
  targetType: "refund", targetId: "r1", diff: { before: { s: 1 }, after: { s: 2 } },
  ipHash: "a".repeat(64), deviceId: "d1", requestId: "req1",
};

async function build(n: number): Promise<AuditEntry[]> {
  const store = new InMemoryAuditStore();
  const chain = new AuditChain(store);
  for (let i = 0; i < n; i++) await chain.append({ ...base, targetId: `r${String(i)}` });
  return store.entries;
}

describe("canonicalJson", () => {
  it("sorts keys and is stable", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalJson({ a: NaN })).toThrow();
  });
});

describe("AuditChain", () => {
  it("verifies, links and uses UUIDv7 ids", async () => {
    const es = await build(5);
    expect(verifyChain(es)).toEqual({ ok: true });
    expect(es[1]?.prevHash).toBe(es[0]?.hash);
    expect(es[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(verifyChain([])).toEqual({ ok: true });
  });
  it("redacts PII in the diff", async () => {
    const store = new InMemoryAuditStore();
    const e = await new AuditChain(store).append({ ...base, diff: { before: { email: "a@b.com" }, after: { phone: "+201001234567" } } });
    expect(JSON.stringify(e.diff)).not.toMatch(/a@b\.com|2010012345/);
  });
  it("rejects invalid input incl. raw (non-hash) ip", async () => {
    await expect(new AuditChain(new InMemoryAuditStore()).append({ ...base, ipHash: "1.2.3.4" })).rejects.toThrow();
  });
  it("serialises concurrent appends into one valid chain", async () => {
    const store = new InMemoryAuditStore();
    const chain = new AuditChain(store);
    await Promise.all(Array.from({ length: 20 }, (_, i) => chain.append({ ...base, targetId: `t${String(i)}` })));
    expect(verifyChain(store.entries)).toEqual({ ok: true });
  });
  it("breaks at the right index when any field is tampered", async () => {
    const es = await build(4);
    const fields: Partial<AuditEntry>[] = [
      { marketId: "SA" }, { actorType: "user" }, { actorId: "x" }, { action: "x" }, { targetType: "x" },
      { targetId: "x" }, { diff: null }, { ipHash: "b".repeat(64) }, { deviceId: "x" }, { requestId: "x" },
      { occurredAt: "2000-01-01T00:00:00.000Z" }, { id: uuidv7() },
    ];
    for (const patch of fields) {
      const t = es.map((e, i) => (i === 2 ? { ...e, ...patch } : e));
      expect(verifyChain(t)).toEqual({ ok: false, brokenIndex: 2 });
    }
    const forged = es.map((e, i) => (i === 1 ? { ...e, prevHash: "f".repeat(64) } : e));
    expect(verifyChain(forged)).toEqual({ ok: false, brokenIndex: 1 });
  });
  it("detects reorder, deletion and truncated head", async () => {
    const es = await build(4);
    const [a, b, c, d] = es as [AuditEntry, AuditEntry, AuditEntry, AuditEntry];
    expect(verifyChain([a, c, b, d])).toEqual({ ok: false, brokenIndex: 1 });
    expect(verifyChain([a, c, d])).toEqual({ ok: false, brokenIndex: 1 });
    expect(verifyChain([b, c, d])).toEqual({ ok: false, brokenIndex: 0 });
  });
  it("property: append* always verifies, and mutating one entry breaks at its index", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ action: fc.string({ minLength: 1 }), targetId: fc.string({ minLength: 1 }), v: fc.jsonValue() }), { minLength: 1, maxLength: 12 }),
        fc.nat(),
        async (items, k) => {
          const store = new InMemoryAuditStore();
          const chain = new AuditChain(store);
          for (const it of items) {
            await chain.append({ ...base, action: it.action, targetId: it.targetId, diff: { after: it.v } });
          }
          expect(verifyChain(store.entries)).toEqual({ ok: true });
          const i = k % items.length;
          const t = store.entries.map((e, j) => (j === i ? { ...e, action: `${e.action}!` } : e));
          expect(verifyChain(t)).toEqual({ ok: false, brokenIndex: i });
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("edge cases", () => {
  it("canonicalJson rejects unsupported types and nulls array holes", () => {
    expect(() => canonicalJson(1n)).toThrow();
    expect(canonicalJson([undefined, true])).toBe("[null,true]");
  });
  it("verifyChain flags an entry that cannot be canonicalised", async () => {
    const es = await build(2);
    const bad = es.map((e, i) => (i === 1 ? { ...e, diff: { after: Number.NaN } } : e));
    expect(verifyChain(bad)).toEqual({ ok: false, brokenIndex: 1 });
  });
  it("append with null diff and null optional fields works", async () => {
    const store = new InMemoryAuditStore();
    await new AuditChain(store).append({ ...base, diff: null, ipHash: null, deviceId: null, requestId: null, actorId: null });
    expect(verifyChain(store.entries)).toEqual({ ok: true });
  });
});
