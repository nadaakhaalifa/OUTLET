import { uuidv7 } from "@outlet/ids";
import { withTestDb } from "@outlet/db/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_LEASE_MS, IDEMPOTENCY_TTL_MS, IdempotencyStore, requestHash } from "../src/index.js";

const actorId = "0197c0de-0000-7000-8000-0000000000aa";
const route = "POST /v1/checkout";
const mk = (hash = requestHash({ a: 1 })) => ({ key: uuidv7(), actorId, route, requestHash: hash });

describe("IdempotencyStore", () => {
  it("fresh, then in_progress, then replay with the same response", async () => {
    await withTestDb(async (db) => {
      const s = new IdempotencyStore(db);
      const req = mk();
      expect(await s.begin(req)).toEqual({ kind: "fresh" });
      expect(await s.begin(req)).toEqual({ kind: "in_progress" });
      await s.complete(req, { status: 201, body: { id: "x", n: [1, null] } });
      expect(await s.begin(req)).toEqual({ kind: "replay", response: { status: 201, body: { id: "x", n: [1, null] } } });
    });
  });

  it("a redacted response persists no body and replays as redacted", async () => {
    await withTestDb(async (db) => {
      const s = new IdempotencyStore(db);
      const req = mk();
      await s.begin(req);
      await s.complete(req, { status: 200, body: { access_token: "secret" }, redacted: true });
      const row = await db.query<{ response_body: unknown }>("SELECT response_body FROM idempotency_keys WHERE key = $1", [req.key]);
      expect(JSON.stringify(row.rows)).not.toContain("secret");
      expect(await s.begin(req)).toEqual({ kind: "replay", response: { status: 200, body: null, redacted: true } });
    });
  });

  it("same key with a different hash is a conflict (in progress or completed)", async () => {
    await withTestDb(async (db) => {
      const s = new IdempotencyStore(db);
      const req = mk();
      await s.begin(req);
      const other = { ...req, requestHash: requestHash({ a: 2 }) };
      expect(await s.begin(other)).toEqual({ kind: "conflict" });
      await s.complete(req, { status: 200, body: null });
      expect(await s.begin(other)).toEqual({ kind: "conflict" });
    });
  });

  it("scopes by actor and route", async () => {
    await withTestDb(async (db) => {
      const s = new IdempotencyStore(db);
      const req = mk();
      await s.begin(req);
      expect(await s.begin({ ...req, actorId: uuidv7() })).toEqual({ kind: "fresh" });
      expect(await s.begin({ ...req, route: "POST /v1/other" })).toEqual({ kind: "fresh" });
    });
  });

  it("honours the 24 h expiry: expired key is fresh again, live key is not", async () => {
    await withTestDb(async (db) => {
      let t = Date.parse("2026-11-08T00:00:00Z");
      const s = new IdempotencyStore(db, () => new Date(t));
      const req = mk();
      await s.begin(req);
      await s.complete(req, { status: 200, body: { v: 1 } });
      t += IDEMPOTENCY_TTL_MS - 1;
      expect((await s.begin(req)).kind).toBe("replay");
      t += 1;
      expect(await s.begin(req)).toEqual({ kind: "fresh" }); // taken over, even with a different body hash
      t += IDEMPOTENCY_TTL_MS;
      expect(await s.begin({ ...req, requestHash: requestHash({ a: 9 }) })).toEqual({ kind: "fresh" });
    });
  });

  it("concurrent same-key requests produce exactly one fresh", async () => {
    await withTestDb(async (db) => {
      const s = new IdempotencyStore(db);
      const req = mk();
      const results = await Promise.all(Array.from({ length: 10 }, () => s.begin(req)));
      expect(results.filter((r) => r.kind === "fresh")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "in_progress")).toHaveLength(9);
    });
  });

  it("an in-progress key whose lease expired is taken over by a same-hash retry; a different hash still conflicts", async () => {
    await withTestDb(async (db) => {
      let t = Date.parse("2026-11-08T00:00:00Z");
      const s = new IdempotencyStore(db, () => new Date(t));
      const req = mk();
      expect(await s.begin(req)).toEqual({ kind: "fresh" });
      t += IDEMPOTENCY_LEASE_MS - 1;
      expect(await s.begin(req)).toEqual({ kind: "in_progress" });
      t += 1;
      expect(await s.begin({ ...req, requestHash: requestHash({ a: 2 }) })).toEqual({ kind: "conflict" });
      expect(await s.begin(req)).toEqual({ kind: "fresh" }); // taken over, with a new lease
      expect(await s.begin(req)).toEqual({ kind: "in_progress" });
      await s.complete(req, { status: 201, body: { ok: true } });
      t += IDEMPOTENCY_LEASE_MS * 10; // completed rows never expire by lease: replay, not takeover
      expect(await s.begin(req)).toEqual({ kind: "replay", response: { status: 201, body: { ok: true } } });
    });
  });

  it("concurrent takeovers of an expired lease produce exactly one fresh", async () => {
    await withTestDb(async (db) => {
      let t = Date.parse("2026-11-08T00:00:00Z");
      const s = new IdempotencyStore(db, () => new Date(t));
      const req = mk();
      await s.begin(req);
      t += IDEMPOTENCY_LEASE_MS;
      const results = await Promise.all(Array.from({ length: 10 }, () => s.begin(req)));
      expect(results.filter((r) => r.kind === "fresh")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "in_progress")).toHaveLength(9);
    });
  });

  it("abandon releases an in-progress key but never a completed one", async () => {
    await withTestDb(async (db) => {
      const s = new IdempotencyStore(db);
      const a = mk();
      await s.begin(a);
      await s.abandon(a);
      expect(await s.begin(a)).toEqual({ kind: "fresh" });
      await s.complete(a, { status: 200, body: {} });
      await s.abandon(a);
      expect((await s.begin(a)).kind).toBe("replay");
    });
  });

  it("complete without a begin throws; purge removes only expired rows", async () => {
    await withTestDb(async (db) => {
      let t = Date.parse("2026-11-08T00:00:00Z");
      const s = new IdempotencyStore(db, () => new Date(t));
      await expect(s.complete(mk(), { status: 200, body: {} })).rejects.toThrow(/no in-progress/);
      await s.begin(mk());
      t += IDEMPOTENCY_TTL_MS;
      await s.begin(mk());
      expect(await s.purgeExpired()).toBe(1);
    });
  });

  it("validates input at the boundary", async () => {
    await withTestDb(async (db) => {
      const s = new IdempotencyStore(db);
      await expect(s.begin({ ...mk(), key: "nope" })).rejects.toThrow();
      await expect(s.begin({ ...mk(), requestHash: new Uint8Array(5) })).rejects.toThrow();
      const req = mk();
      await s.begin(req);
      await expect(s.complete(req, { status: 99, body: {} })).rejects.toThrow();
    });
  });
});

describe("requestHash", () => {
  it("is 32 bytes and independent of key order", () => {
    expect(requestHash({ a: 1, b: { c: [1, 2], d: "x" } })).toEqual(requestHash({ b: { d: "x", c: [1, 2] }, a: 1 }));
    expect(requestHash({}).length).toBe(32);
  });
  it("differs for different bodies (property)", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        fc.pre(JSON.stringify(a) !== JSON.stringify(b));
        const same = JSON.stringify(a, Object.keys(a ?? {}).sort()) === JSON.stringify(b, Object.keys(b ?? {}).sort());
        fc.pre(!same);
        return Buffer.compare(requestHash(a), requestHash(b)) !== 0 || JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 100 },
    );
  });
  it("handles bigint, undefined fields and rejects unsupported values", () => {
    expect(requestHash({ a: 5n, b: undefined })).toEqual(requestHash({ a: "5" }));
    expect(() => requestHash({ a: Number.NaN })).toThrow(TypeError);
    expect(() => requestHash({ a: () => 1 })).toThrow(TypeError);
    expect(requestHash([null, true, "s", 1.5])).toHaveLength(32);
  });
});
