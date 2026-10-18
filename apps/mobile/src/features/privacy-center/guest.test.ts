import { describe, expect, it } from "vitest";
import { GUEST_SIZE_PROFILE_KEY } from "../guest/session";
import { clearLocalData } from "./guest";

describe("guest privacy panel", () => {
  it("clears the guest store and the size profile key", async () => {
    const removed: string[] = [];
    let cleared = 0;
    const r = await clearLocalData({ clearAll: async () => { cleared += 1; } }, { remove: async (k) => { removed.push(k); } });
    expect(r).toBe("cleared");
    expect(cleared).toBe(1);
    expect(removed).toEqual([GUEST_SIZE_PROFILE_KEY]);
  });
  it("reports a storage failure instead of throwing", async () => {
    expect(await clearLocalData({ clearAll: async () => { throw new Error("x"); } }, { remove: async () => undefined })).toBe("failed");
  });
});
