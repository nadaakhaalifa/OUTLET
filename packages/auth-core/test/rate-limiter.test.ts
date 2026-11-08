import { describe, expect, it } from "vitest";
import { withTestDb } from "@outlet/db/testing";
import { InMemoryRateLimiter, PgRateLimiter } from "../src/index.js";
import type { RateLimiter } from "../src/index.js";
import { at } from "./helpers.js";

const contract = (name: string, run: (fn: (l: RateLimiter) => Promise<void>) => Promise<void>): void => {
  describe(`${name} rate limiter contract`, () => {
    it("allows up to the limit, then blocks with a retry-after pointing at the oldest hit leaving the window", async () => {
      await run(async (l) => {
        expect(await l.hit("k", 2, 60_000, at(0))).toEqual({ allowed: true, remaining: 1 });
        expect(await l.hit("k", 2, 60_000, at(10_000))).toEqual({ allowed: true, remaining: 0 });
        expect(await l.hit("k", 2, 60_000, at(20_000))).toEqual({ allowed: false, remaining: 0, retryAfterMs: 40_000 });
        // a blocked attempt is not recorded: after the first hit expires there is room for exactly one more
        expect((await l.hit("k", 2, 60_000, at(60_001))).allowed).toBe(true);
        expect((await l.hit("k", 2, 60_000, at(60_002))).allowed).toBe(false);
      });
    });
    it("keys are independent and limit 0 always blocks", async () => {
      await run(async (l) => {
        expect((await l.hit("a", 1, 1_000, at(0))).allowed).toBe(true);
        expect((await l.hit("b", 1, 1_000, at(0))).allowed).toBe(true);
        expect((await l.hit("a", 1, 1_000, at(1))).allowed).toBe(false);
        const zero = await l.hit("z", 0, 1_000, at(0));
        expect(zero.allowed).toBe(false);
        expect(zero.remaining).toBe(0);
      });
    });
    it("a hit exactly on the window boundary has expired", async () => {
      await run(async (l) => {
        await l.hit("edge", 1, 1_000, at(0));
        expect((await l.hit("edge", 1, 1_000, at(1_000))).allowed).toBe(true);
      });
    });
  });
};

contract("InMemory", (fn) => fn(new InMemoryRateLimiter()));
contract("Pg", (fn) => withTestDb((db) => fn(new PgRateLimiter(db, "EG"))));
