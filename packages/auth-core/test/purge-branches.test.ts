import type { Queryable } from "@outlet/db";
import { describe, expect, it } from "vitest";
import { purgeExpired } from "../src/purge.js";

describe("purgeExpired count parsing", () => {
  it("treats a missing result row as zero deleted and parses counts otherwise", async () => {
    let i = 0;
    const seen: string[] = [];
    const db = { query: (sql: string) => { seen.push(sql); i += 1; return Promise.resolve({ rows: i % 2 === 0 ? [] : [{ n: String(i) }] }); } } as unknown as Queryable;
    const r = await purgeExpired(db, new Date("2026-01-10T00:00:00Z"));
    expect(r).toEqual({ otpChallenges: 1, rateLimitHits: 0, refreshTokens: 3, ageBlocks: 0, passkeyChallenges: 5 });
    expect(seen).toHaveLength(5);
    expect(seen[3]).toContain("age_blocks");
  });
});
