import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  DEFAULT_LEASE_MS,
  DEFAULT_TTL_MS,
  hashRequest,
  IdempotencyInFlightError,
  IdempotencyKeyReuseError,
  IdempotencyService,
  IdempotencyStoreError,
  InMemoryIdempotencyStore,
  InvalidIdempotencyKeyError,
  OpaqueKeySchema,
  ScopeSchema,
  sha256Hex,
  UncanonicalizableRequestError,
  UUID_V7,
  utf8Encode,
  type IdempotencyStore,
  type StoredResponse,
} from "./index";

const KEY = "0190a5f0-7b3c-7abc-8def-0123456789ab";
const ref = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const resp = (status: number, body: StoredResponse["body"] = { ok: true }): StoredResponse => ({
  status,
  headers: {},
  body,
});

describe("canonicalize exact output", () => {
  it("serialises every scalar type to its exact form", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
    expect(canonicalize("a\"b")).toBe('"a\\"b"');
    expect(canonicalize(12n)).toBe('{"$bigint":"12"}');
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(-1.5)).toBe("-1.5");
    expect(canonicalize([1, "a", null, [true]])).toBe('[1,"a",null,[true]]');
    expect(canonicalize({})).toBe("{}");
    expect(canonicalize([])).toBe("[]");
  });
  it("sorts keys by code unit regardless of insertion order", () => {
    expect(canonicalize({ c: 1, a: 2, b: 3 })).toBe('{"a":2,"b":3,"c":1}');
    expect(canonicalize({ b: 1, c: 2, a: 3 })).toBe('{"a":3,"b":1,"c":2}');
    expect(canonicalize({ a: 3, c: 2, b: 1 })).toBe('{"a":3,"b":1,"c":2}');
    expect(canonicalize({ B: 1, a: 2, A: 3 })).toBe('{"A":3,"B":1,"a":2}');
  });
  it("allows shared (non-cyclic) references and null-prototype objects", () => {
    const shared = { x: 1 };
    expect(canonicalize({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    expect(canonicalize([shared, shared])).toBe('[{"x":1},{"x":1}]');
    const np = Object.create(null) as Record<string, unknown>;
    np["k"] = 1;
    expect(canonicalize(np)).toBe('{"k":1}');
  });
  it("rejects with specific messages", () => {
    expect(() => canonicalize(Infinity)).toThrow("non-finite number");
    expect(() => canonicalize(new Date(0))).toThrow("non-plain object");
    expect(() => canonicalize(new Map())).toThrow("non-plain object");
    class Foo {
      readonly a = 1;
    }
    expect(() => canonicalize(new Foo())).toThrow(UncanonicalizableRequestError);
    expect(() => canonicalize(new Foo())).toThrow("non-plain object");
    expect(() => canonicalize(undefined)).toThrow("unsupported type: undefined");
    expect(() => canonicalize(() => 1)).toThrow("unsupported type: function");
    expect(() => canonicalize(Symbol("s"))).toThrow("unsupported type: symbol");
    const a: unknown[] = [];
    a.push(a);
    expect(() => canonicalize(a)).toThrow("cyclic structure");
  });
});

describe("hashRequest", () => {
  it("is the sha256 of the exact canonical envelope with upper-cased method", () => {
    const expected = ref('{"body":null,"method":"POST","query":null,"route":"POST /v1/x"}');
    expect(hashRequest({ method: "post", route: "POST /v1/x" })).toBe(expected);
    expect(hashRequest({ method: "POST", route: "POST /v1/x" })).toBe(expected);
    expect(hashRequest({ method: "post", route: "R", query: { a: 1 }, body: [1] })).toBe(
      ref('{"body":[1],"method":"POST","query":{"a":1},"route":"R"}'),
    );
  });
});

describe("sha256 / utf8", () => {
  it("matches node:crypto over boundary code points and padding lengths", () => {
    const samples = [
      "\u007f", "\u0080", "é", "߿", "ࠀ", "€", "퟿", "", "￿",
      "\u{10000}", "\u{1f600}", "\u{10ffff}", "à", "مرحبا",
    ];
    for (const s of samples) expect(sha256Hex(s)).toBe(ref(s));
    for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
      const s = "x".repeat(n);
      expect(sha256Hex(s)).toBe(ref(s));
    }
  });
  it("encodes exact UTF-8 bytes per width class", () => {
    expect([...utf8Encode("\u007f")]).toEqual([0x7f]);
    expect([...utf8Encode("\u0080")]).toEqual([0xc2, 0x80]);
    expect([...utf8Encode("߿")]).toEqual([0xdf, 0xbf]);
    expect([...utf8Encode("ࠀ")]).toEqual([0xe0, 0xa0, 0x80]);
    expect([...utf8Encode("￿")]).toEqual([0xef, 0xbf, 0xbf]);
    expect([...utf8Encode("\u{10000}")]).toEqual([0xf0, 0x90, 0x80, 0x80]);
    expect([...utf8Encode("\u{10ffff}")]).toEqual([0xf4, 0x8f, 0xbf, 0xbf]);
  });
  it("replaces lone surrogates with U+FFFD but keeps neighbours of the range", () => {
    const fffd = [0xef, 0xbf, 0xbd];
    expect([...utf8Encode("\ud800")]).toEqual(fffd);
    expect([...utf8Encode("\udbff")]).toEqual(fffd);
    expect([...utf8Encode("\udc00")]).toEqual(fffd);
    expect([...utf8Encode("\udfff")]).toEqual(fffd);
    expect([...utf8Encode("퟿")]).toEqual([0xed, 0x9f, 0xbf]);
    expect([...utf8Encode("")]).toEqual([0xee, 0x80, 0x80]);
  });
});

describe("schemas", () => {
  it("UUID_V7 is anchored, version/variant checked and case-insensitive", () => {
    expect(UUID_V7.test(KEY)).toBe(true);
    expect(UUID_V7.test(KEY.toUpperCase())).toBe(true);
    expect(UUID_V7.test(`x${KEY}`)).toBe(false);
    expect(UUID_V7.test(`${KEY}x`)).toBe(false);
    expect(UUID_V7.test(KEY.replace("-7abc-", "-4abc-"))).toBe(false);
    expect(UUID_V7.test(KEY.replace("-8def-", "-cdef-"))).toBe(false);
  });
  it("OpaqueKeySchema bounds and charset", () => {
    expect(OpaqueKeySchema.safeParse("a").success).toBe(true);
    expect(OpaqueKeySchema.safeParse("evt_123").success).toBe(true);
    expect(OpaqueKeySchema.safeParse("a".repeat(255)).success).toBe(true);
    expect(OpaqueKeySchema.safeParse("a".repeat(256)).success).toBe(false);
    expect(OpaqueKeySchema.safeParse("").success).toBe(false);
    expect(OpaqueKeySchema.safeParse("a b").success).toBe(false);
    expect(OpaqueKeySchema.safeParse(" ab").success).toBe(false);
    expect(OpaqueKeySchema.safeParse("ab ").success).toBe(false);
    expect(OpaqueKeySchema.safeParse("abé").success).toBe(false);
    expect(OpaqueKeySchema.safeParse("!~").success).toBe(true);
  });
  it("ScopeSchema requires non-empty actor and key", () => {
    expect(ScopeSchema.safeParse({}).success).toBe(false);
    expect(ScopeSchema.safeParse({ actor: "", key: "k" }).success).toBe(false);
    expect(ScopeSchema.safeParse({ actor: "a", key: "" }).success).toBe(false);
    expect(ScopeSchema.safeParse({ actor: "user-1", key: "key-1" }).success).toBe(true);
  });
});

describe("InMemoryIdempotencyStore contract", () => {
  const scope = { actor: "u1", key: "k1" };
  const claimReq = (nowMs: number, token = "t1") => ({
    scope,
    route: "POST /r",
    requestHash: "h",
    claimToken: token,
    nowMs,
    ttlMs: 10_000,
    leaseMs: 1_000,
  });
  it("returns the exact acquired result and keeps one record", async () => {
    const s = new InMemoryIdempotencyStore();
    expect(await s.claim(claimReq(0))).toEqual({ kind: "acquired" });
    expect(s.size).toBe(1);
  });
  it("complete and release succeed only for the owning token while in flight", async () => {
    const s = new InMemoryIdempotencyStore();
    expect(await s.complete(scope, "t1", resp(200), 0)).toBe(false); // unknown scope
    expect(await s.release(scope, "t1")).toBe(false);
    await s.claim(claimReq(0));
    expect(await s.complete(scope, "other", resp(200), 0)).toBe(false);
    expect(await s.release(scope, "other")).toBe(false);
    expect(await s.complete(scope, "t1", resp(200), 0)).toBe(true);
    expect(await s.complete(scope, "t1", resp(200), 0)).toBe(false); // already completed
    expect(await s.release(scope, "t1")).toBe(false); // completed records are not releasable
    expect(s.size).toBe(1);
  });
  it("release removes the in-flight record and returns true", async () => {
    const s = new InMemoryIdempotencyStore();
    await s.claim(claimReq(0));
    expect(await s.release(scope, "t1")).toBe(true);
    expect(s.size).toBe(0);
    expect((await s.claim(claimReq(1, "t2"))).kind).toBe("acquired");
  });
  it("completed records survive the lease but expire exactly at ttl", async () => {
    const s = new InMemoryIdempotencyStore();
    await s.claim(claimReq(0));
    await s.complete(scope, "t1", resp(200), 0);
    const mid = await s.claim(claimReq(5_000, "t2"));
    expect(mid.kind).toBe("existing");
    if (mid.kind === "existing") expect(mid.record.state).toBe("completed");
    expect((await s.claim(claimReq(9_999, "t3"))).kind).toBe("existing");
    expect((await s.claim(claimReq(10_000, "t4"))).kind).toBe("acquired");
  });
  it("in-flight records are taken over exactly at lease expiry", async () => {
    const s = new InMemoryIdempotencyStore();
    await s.claim(claimReq(0));
    const before = await s.claim(claimReq(999, "t2"));
    expect(before.kind).toBe("existing");
    if (before.kind === "existing") expect(before.record.state).toBe("in_flight");
    expect((await s.claim(claimReq(1_000, "t3"))).kind).toBe("acquired");
    // the old owner can no longer complete
    expect(await s.complete(scope, "t1", resp(200), 1_000)).toBe(false);
  });
});

describe("IdempotencyService exact behaviour", () => {
  function make(opts: { store?: IdempotencyStore; keyPolicy?: "uuidv7" | "opaque" } = {}) {
    let n = 0;
    const store = opts.store ?? new InMemoryIdempotencyStore();
    const svc = new IdempotencyService({
      store,
      clock: { nowMs: () => 1_000 },
      newClaimToken: () => `t${++n}`,
      ...(opts.keyPolicy ? { keyPolicy: opts.keyPolicy } : {}),
    });
    return { svc, store };
  }
  const input = (over: Partial<Parameters<IdempotencyService["execute"]>[0]> = {}) => ({
    key: KEY,
    route: "POST /r",
    actor: "u1",
    requestHash: "h1",
    handler: () => Promise.resolve(resp(201, { id: 1 })),
    ...over,
  });

  it("exports sane defaults", () => {
    expect(DEFAULT_TTL_MS).toBe(86_400_000);
    expect(DEFAULT_LEASE_MS).toBe(300_000);
  });
  it("applies the key policy", async () => {
    const uuid = make();
    await expect(uuid.svc.execute(input({ key: "evt_1" }))).rejects.toThrow(InvalidIdempotencyKeyError);
    await expect(uuid.svc.execute(input({ key: "" }))).rejects.toThrow("Idempotency-Key is missing or malformed");
    const opaque = make({ keyPolicy: "opaque" });
    await expect(opaque.svc.execute(input({ key: "evt_1" }))).resolves.toMatchObject({ replayed: false });
    await expect(opaque.svc.execute(input({ key: "a b" }))).rejects.toThrow(InvalidIdempotencyKeyError);
  });
  it("first run is not replayed and stored; replay returns the stored body without running", async () => {
    const { svc } = make();
    let runs = 0;
    const handler = () => {
      runs++;
      return Promise.resolve(resp(201, { id: runs }));
    };
    expect(await svc.execute(input({ handler }))).toEqual({
      response: { status: 201, headers: {}, body: { id: 1 } },
      replayed: false,
      stored: true,
    });
    expect(await svc.execute(input({ handler }))).toEqual({
      response: { status: 201, headers: {}, body: { id: 1 } },
      replayed: true,
      stored: true,
    });
    expect(runs).toBe(1);
  });
  it("rejects reuse when only the hash or only the route differs", async () => {
    const { svc } = make();
    await svc.execute(input());
    await expect(svc.execute(input({ requestHash: "h2" }))).rejects.toThrow(IdempotencyKeyReuseError);
    await expect(svc.execute(input({ route: "POST /other" }))).rejects.toThrow(IdempotencyKeyReuseError);
    await expect(svc.execute(input({ requestHash: "h2" }))).rejects.toThrow(
      "Idempotency-Key was already used with a different request",
    );
  });
  it("reports in-flight with its message and different actors are isolated", async () => {
    const { svc } = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = svc.execute(input({ handler: async () => (await gate, resp(200)) }));
    await expect(svc.execute(input())).rejects.toThrow(IdempotencyInFlightError);
    await expect(svc.execute(input())).rejects.toThrow("a request with this Idempotency-Key is still in progress");
    await expect(svc.execute(input({ actor: "u2" }))).resolves.toMatchObject({ replayed: false });
    release();
    await first;
  });
  it("5xx boundary: 500 is not stored, 499 is", async () => {
    const { svc } = make();
    const r500 = await svc.execute(input({ handler: () => Promise.resolve(resp(500)) }));
    expect(r500).toEqual({ response: resp(500), replayed: false, stored: false });
    const again = await svc.execute(input({ handler: () => Promise.resolve(resp(200)) }));
    expect(again.replayed).toBe(false);
    const r499 = await svc.execute(input({ key: "0190a5f0-7b3c-7abc-8def-0123456789ac", handler: () => Promise.resolve(resp(499)) }));
    expect(r499.stored).toBe(true);
    const r599 = await svc.execute(input({ key: "0190a5f0-7b3c-7abc-8def-0123456789ad", handler: () => Promise.resolve(resp(599)) }));
    expect(r599.stored).toBe(false);
  });
  it("describes store claim failures", async () => {
    const base = new InMemoryIdempotencyStore();
    const boom: IdempotencyStore = {
      claim: () => Promise.reject(new Error("db down")),
      complete: (...a) => base.complete(...a),
      release: (...a) => base.release(...a),
    };
    const a = make({ store: boom });
    await expect(a.svc.execute(input())).rejects.toThrow(IdempotencyStoreError);
    await expect(a.svc.execute(input())).rejects.toThrow("claim failed: db down");
    const weird: IdempotencyStore = { ...boom, claim: () => Promise.reject("str") };
    await expect(make({ store: weird }).svc.execute(input())).rejects.toThrow("claim failed: unknown");
  });
  it("hands the handler claim data from the clock: lease and ttl defaults are propagated", async () => {
    const seen: { ttlMs: number; leaseMs: number; nowMs: number }[] = [];
    const base = new InMemoryIdempotencyStore();
    const spy: IdempotencyStore = {
      claim: (r) => {
        seen.push({ ttlMs: r.ttlMs, leaseMs: r.leaseMs, nowMs: r.nowMs });
        return base.claim(r);
      },
      complete: (...a) => base.complete(...a),
      release: (...a) => base.release(...a),
    };
    await make({ store: spy }).svc.execute(input());
    expect(seen).toEqual([{ ttlMs: 86_400_000, leaseMs: 300_000, nowMs: 1_000 }]);
  });
});
