import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  hashRequest,
  httpStatusFor,
  IdempotencyInFlightError,
  IdempotencyKeyReuseError,
  IdempotencyService,
  IdempotencyStoreError,
  InMemoryIdempotencyStore,
  InvalidIdempotencyKeyError,
  sha256Hex,
  UncanonicalizableRequestError,
  type IdempotencyStore,
  type StoredResponse,
} from "./index";

const KEY = "0190a5f0-7b3c-7abc-8def-0123456789ab";
const DAY = 24 * 60 * 60 * 1000;

function setup(overrides: { store?: IdempotencyStore } = {}) {
  let now = 1_000_000;
  let n = 0;
  const store = overrides.store ?? new InMemoryIdempotencyStore();
  const svc = new IdempotencyService({
    store,
    clock: { nowMs: () => now },
    newClaimToken: () => `t${++n}`,
  });
  return { svc, store, advance: (ms: number) => (now += ms) };
}
const ok = (body: StoredResponse["body"], status = 201): StoredResponse => ({ status, headers: {}, body });
const req = (body: unknown = { a: 1 }) =>
  hashRequest({ method: "post", route: "POST /v1/orders", body: body as never });

describe("sha256", () => {
  it("matches known vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });
});

describe("canonicalize / hashRequest", () => {
  it("is key-order independent and array-order dependent", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalize({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });
  it("distinguishes bigint from number and normalises -0", () => {
    expect(canonicalize(1n)).not.toBe(canonicalize(1));
    expect(canonicalize(-0)).toBe(canonicalize(0));
  });
  it("rejects undefined, NaN, cycles", () => {
    expect(() => canonicalize({ a: undefined })).toThrow(UncanonicalizableRequestError);
    expect(() => canonicalize(NaN)).toThrow(UncanonicalizableRequestError);
    const c: Record<string, unknown> = {};
    c["self"] = c;
    expect(() => canonicalize(c)).toThrow(UncanonicalizableRequestError);
  });
  it("hash changes with route, method and body", () => {
    const base = { method: "POST", route: "POST /a", body: { x: 1 } };
    expect(hashRequest(base)).toBe(hashRequest({ ...base, method: "post" }));
    expect(hashRequest(base)).not.toBe(hashRequest({ ...base, route: "POST /b" }));
    expect(hashRequest(base)).not.toBe(hashRequest({ ...base, body: { x: 2 } }));
  });
  it("property: shuffled object keys hash equal", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer()), (d) => {
        const rev = Object.fromEntries(Object.entries(d).reverse());
        expect(canonicalize(rev)).toBe(canonicalize(d));
      }),
    );
  });
});

describe("IdempotencyService", () => {
  it("runs the handler once and replays the stored response", async () => {
    const { svc } = setup();
    let calls = 0;
    const input = { key: KEY, route: "POST /v1/orders", actor: "u1", requestHash: req(), handler: () => { calls++; return Promise.resolve(ok({ id: "o1" })); } };
    const first = await svc.execute(input);
    const second = await svc.execute(input);
    expect(calls).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({ replayed: true, response: first.response });
  });

  it("same key, different hash -> 422 error", async () => {
    const { svc } = setup();
    await svc.execute({ key: KEY, route: "POST /v1/orders", actor: "u1", requestHash: req({ a: 1 }), handler: () => Promise.resolve(ok({})) });
    const err = await svc
      .execute({ key: KEY, route: "POST /v1/orders", actor: "u1", requestHash: req({ a: 2 }), handler: () => Promise.resolve(ok({})) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdempotencyKeyReuseError);
    expect(httpStatusFor(err)).toBe(422);
  });

  it("same key on a different actor is independent", async () => {
    const { svc } = setup();
    let calls = 0;
    const h = () => { calls++; return Promise.resolve(ok({})); };
    await svc.execute({ key: KEY, route: "r", actor: "u1", requestHash: "h", handler: h });
    await svc.execute({ key: KEY, route: "r", actor: "u2", requestHash: "h", handler: h });
    expect(calls).toBe(2);
  });

  it("concurrent request while in flight -> typed conflict (409), handler runs once", async () => {
    const { svc } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow = async () => { calls++; await gate; return ok({ id: 1 }); };
    const base = { key: KEY, route: "r", actor: "u1", requestHash: "h" };
    const p1 = svc.execute({ ...base, handler: slow });
    const err = await svc.execute({ ...base, handler: slow }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdempotencyInFlightError);
    expect(httpStatusFor(err)).toBe(409);
    release();
    await p1;
    expect((await svc.execute({ ...base, handler: slow })).replayed).toBe(true);
    expect(calls).toBe(1);
  });

  it("expires after 24h using the injected clock", async () => {
    const { svc, advance } = setup();
    let calls = 0;
    const input = { key: KEY, route: "r", actor: "u1", requestHash: "h", handler: () => { calls++; return Promise.resolve(ok({})); } };
    await svc.execute(input);
    advance(DAY - 1);
    expect((await svc.execute(input)).replayed).toBe(true);
    advance(1);
    expect((await svc.execute(input)).replayed).toBe(false);
    expect(calls).toBe(2);
  });

  it("stores 4xx and replays it; does not store 5xx", async () => {
    const { svc } = setup();
    const mk = (status: number) => ({ key: KEY, route: "r", actor: "u1", requestHash: "h", handler: () => { return Promise.resolve(ok({ e: 1 }, status)); } });
    await svc.execute(mk(409));
    expect((await svc.execute(mk(409))).replayed).toBe(true);
    const { svc: s2 } = setup();
    const r1 = await s2.execute(mk(503));
    expect(r1.stored).toBe(false);
    expect((await s2.execute(mk(201))).replayed).toBe(false);
  });

  it("handler throw releases the key so a retry re-runs", async () => {
    const { svc, store } = setup();
    const base = { key: KEY, route: "r", actor: "u1", requestHash: "h" };
    await expect(svc.execute({ ...base, handler: () => Promise.reject(new Error("boom")) })).rejects.toThrow("boom");
    expect((store as InMemoryIdempotencyStore).size).toBe(0);
    expect((await svc.execute({ ...base, handler: () => Promise.resolve(ok({})) })).replayed).toBe(false);
  });

  it("crashed claim can be taken over after the lease", async () => {
    const { svc, advance } = setup();
    const base = { key: KEY, route: "r", actor: "u1", requestHash: "h" };
    void svc.execute({ ...base, handler: () => new Promise<StoredResponse>(() => undefined) });
    await Promise.resolve();
    await expect(svc.execute({ ...base, handler: () => Promise.resolve(ok({})) })).rejects.toBeInstanceOf(IdempotencyInFlightError);
    advance(5 * 60 * 1000);
    expect((await svc.execute({ ...base, handler: () => Promise.resolve(ok({})) })).replayed).toBe(false);
  });

  it("fails closed when the store is down: handler not run", async () => {
    const broken: IdempotencyStore = {
      claim: () => Promise.reject(new Error("down")),
      complete: () => Promise.resolve(false),
      release: () => Promise.resolve(false),
    };
    const { svc } = setup({ store: broken });
    let calls = 0;
    const err = await svc
      .execute({ key: KEY, route: "r", actor: "u", requestHash: "h", handler: () => { calls++; return Promise.resolve(ok({})); } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdempotencyStoreError);
    expect(calls).toBe(0);
  });

  it("rejects malformed keys (400)", async () => {
    const { svc } = setup();
    const err = await svc.execute({ key: "not-a-uuid", route: "r", actor: "u", requestHash: "h", handler: () => Promise.resolve(ok({})) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidIdempotencyKeyError);
    expect(httpStatusFor(err)).toBe(400);
  });

  it("property: N replays return the first response, handler runs once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), fc.integer({ min: 200, max: 499 }), fc.integer({ min: 1, max: 8 }), async (body, status, n) => {
        const { svc } = setup();
        let calls = 0;
        const input = {
          key: KEY, route: "r", actor: "u", requestHash: "h",
          handler: () => { calls++; return Promise.resolve({ status, headers: {}, body: body as StoredResponse["body"] }); },
        };
        const first = await svc.execute(input);
        for (let i = 0; i < n; i++) {
          const again = await svc.execute(input);
          expect(again.replayed).toBe(true);
          expect(again.response).toEqual(first.response);
        }
        expect(calls).toBe(1);
      }),
      { numRuns: 100 },
    );
  });

  it("property: parallel same-key requests run the handler exactly once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 10 }), async (n) => {
        const { svc } = setup();
        let calls = 0;
        const run = () => svc.execute({
          key: KEY, route: "r", actor: "u", requestHash: "h",
          handler: async () => { calls++; await Promise.resolve(); return ok({ id: 1 }); },
        }).then((r) => r, (e: unknown) => e);
        const results = await Promise.all(Array.from({ length: n }, run));
        expect(calls).toBe(1);
        for (const r of results) {
          if (r instanceof Error) expect(r).toBeInstanceOf(IdempotencyInFlightError);
        }
      }),
    );
  });
});
