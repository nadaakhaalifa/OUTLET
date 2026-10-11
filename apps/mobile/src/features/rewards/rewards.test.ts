import { describe, expect, it } from "vitest";
import {
  FIXTURE_REWARDS as R, InMemoryRewardsPort, PortError, canConvert, gameViews, oddsValid, percentText, rewardsFailureState, sortedExpiring,
  type RewardsSnapshot,
} from "./model";

const on: RewardsSnapshot = { ...R, gamesEnabled: true };

describe("games gating", () => {
  it("shows no games while the switch is off", () => {
    expect(gameViews(R)).toEqual([]);
  });
  it("shows a playable game only with a valid published odds table", () => {
    const v = gameViews(on);
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe("playable");
    const bad: RewardsSnapshot = { ...on, games: [{ ...on.games[0]!, odds: [{ kind: "coins", coins: 5, basisPoints: 9000 }] }] };
    expect(gameViews(bad)).toEqual([]);
    expect(oddsValid([])).toBe(false);
  });
  it("reports cooldown with the server's next time", () => {
    const g = { ...on.games[0]!, available: false, nextAvailableAtMs: 5 };
    const v = gameViews({ ...on, games: [g] })[0]!;
    expect(v.kind).toBe("cooldown");
    if (v.kind === "cooldown") expect(v.nextAtMs).toBe(5);
  });
});

describe("display helpers", () => {
  it("formats basis points exactly", () => {
    expect(percentText(7000)).toBe("70%");
    expect(percentText(250)).toBe("2.5%");
    expect(percentText(5)).toBe("0.05%");
    expect(percentText(10000)).toBe("100%");
  });
  it("orders expiring coins by real expiry and hides empty buckets", () => {
    const e = sortedExpiring([{ count: 5, expiresAtMs: 20 }, { count: 0, expiresAtMs: 1 }, { count: 7, expiresAtMs: 10 }]);
    expect(e.map((x) => x.expiresAtMs)).toEqual([10, 20]);
  });
  it("converts only a positive balance", () => {
    expect(canConvert(R)).toBe(true);
    expect(canConvert({ ...R, coinBalance: 0 })).toBe(false);
  });
});

describe("port", () => {
  it("converts coins and records the odds version played", async () => {
    const p = new InMemoryRewardsPort(on);
    await p.convert(250);
    expect((await p.load()).coinBalance).toBe(1000);
    await p.play("spin", "v1");
    expect(p.plays).toEqual(["spin:v1"]);
  });
  it("maps failures", async () => {
    const p = new InMemoryRewardsPort(R, "offline");
    await expect(p.load()).rejects.toBeInstanceOf(PortError);
    expect(rewardsFailureState(new PortError("offline"))).toEqual({ status: "error", offline: true });
  });
});
