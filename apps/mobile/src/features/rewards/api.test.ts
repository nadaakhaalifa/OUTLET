import { describe, expect, it, vi } from "vitest";
import type { OutletClient } from "../../services/api-client";
import type { AdapterContext } from "../../services/wire";
import { ApiRewardsPort } from "./api";

type Call = (...a: unknown[]) => Promise<unknown>;
const ok = (data: unknown) => Promise.resolve({ data, etag: null, notModified: false });
const port = (client: Record<string, Call>) =>
  new ApiRewardsPort({ client: client as unknown as OutletClient, locale: () => "ar", nowMs: () => 777, deviceId: () => "device-12345" } as AdapterContext);

const rewards = (over: Record<string, unknown> = {}) => ({
  coins: "1500", credit_piastres: "1500",
  expiring_soon: { coins: "200", earliest_at: "2026-11-01T00:00:00Z" },
  tier: { tier: "Silver", next: { tier: "gold", remaining_piastres: "50000" } },
  games: [{ game: "daily_spin", enabled: true, plays_left_today: 1 }, { game: "scratch_card", enabled: true, plays_left_today: 0 }],
  ...over,
});
const odds = { current: { odds_version_id: "v1", outcomes: [{ kind: "coins", coins: "10", probability_ppm: 250000 }, { kind: "nothing", coins: null, probability_ppm: 750000 }] } };

describe("ApiRewardsPort.load", () => {
  it("maps coins, tier, expiry and disclosed odds in basis points", async () => {
    const snap = await port({ getMyRewards: () => ok(rewards()), getGameOdds: () => ok(odds) }).load();
    expect(snap.coinBalance).toBe(1500);
    expect(snap.coinValue).toBe(1500n);
    expect(snap.expiring).toEqual([{ count: 200, expiresAtMs: Date.parse("2026-11-01T00:00:00Z") }]);
    expect(snap.tier).toEqual({ tier: "silver", nextTier: "gold", remainingToNext: 50000n });
    expect(snap.gamesEnabled).toBe(true);
    const spin = snap.games.find((g) => g.game === "spin");
    expect(spin?.odds).toEqual([{ kind: "coins", coins: 10, basisPoints: 2500 }, { kind: "nothing", coins: 0, basisPoints: 7500 }]);
    expect(spin?.oddsVersion).toBe("v1");
    expect(spin?.available).toBe(true);
    // no plays left today means the game is not available
    expect(snap.games.find((g) => g.game === "scratch")?.available).toBe(false);
  });

  it("omits games with no current odds, and handles the top tier and no expiring coins", async () => {
    const snap = await port({
      getMyRewards: () => ok(rewards({ expiring_soon: { coins: "0", earliest_at: null }, tier: { tier: "unknown-tier", next: null }, games: [{ game: "daily_spin", enabled: false, plays_left_today: 3 }] })),
      getGameOdds: () => ok({ current: null }),
    }).load();
    expect(snap.games).toEqual([]);
    expect(snap.expiring).toEqual([]);
    expect(snap.tier).toEqual({ tier: "bronze", nextTier: null, remainingToNext: null });
    expect(snap.gamesEnabled).toBe(false);
  });

  it("an expiring batch without a date falls back to the device clock", async () => {
    const snap = await port({ getMyRewards: () => ok(rewards({ expiring_soon: { coins: "5", earliest_at: null }, games: [] })), getGameOdds: () => ok(odds) }).load();
    expect(snap.expiring).toEqual([{ count: 5, expiresAtMs: 777 }]);
  });
});

describe("ApiRewardsPort.play and convert", () => {
  it.each([
    [{ kind: "coins", coins: "25" }, { kind: "coins", coins: 25, oddsVersion: "v9" }],
    [{ kind: "coins" }, { kind: "coins", coins: 0, oddsVersion: "v9" }],
    [{ kind: "voucher" }, { kind: "voucher", oddsVersion: "v9" }],
    [{ kind: "nothing" }, { kind: "nothing", oddsVersion: "v9" }],
  ])("maps outcome %j", async (outcome, expected) => {
    const playRewardsGame = vi.fn(() => ok({ odds_version_id: "v9", outcome }));
    expect(await port({ playRewardsGame }).play("scratch", "v9", "k")).toEqual(expected);
    expect(playRewardsGame).toHaveBeenCalledWith({ path: { game: "scratch_card" } }, { idempotencyKey: "k" });
  });

  it("convert is unsupported rather than converting the wrong amount", async () => {
    await expect(port({}).convert(100, "k")).rejects.toMatchObject({ kind: "failed" });
  });
});
