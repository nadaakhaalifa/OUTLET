import { describe, expect, it } from "vitest";
import { SecureStorage, type SecureStoreBackend } from "../../platform/secure-storage";
import { GUEST_SIZE_PROFILE_KEY, LocalSizeProfilePort } from "./local";

function memory(): { backend: SecureStoreBackend; data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, backend: { getItemAsync: async (k) => data.get(k) ?? null, setItemAsync: async (k, v) => { data.set(k, v); }, deleteItemAsync: async (k) => { data.delete(k); } } };
}

describe("guest size profile", () => {
  it("uses the SecureStore key outlet.guest.sizeprofile and no network", async () => {
    expect(GUEST_SIZE_PROFILE_KEY).toBe("outlet.guest.sizeprofile");
    const g = globalThis as { fetch?: unknown };
    const real = g.fetch;
    let calls = 0;
    g.fetch = () => { calls += 1; throw new Error("network"); };
    try {
      const m = memory();
      const port = new LocalSizeProfilePort(new SecureStorage(m.backend));
      expect(await port.list()).toEqual([]);
      const saved = await port.save({ kind: "me", label: "Me", fitPreference: "snug", modestFit: false, measurements: { height: 1700, waist: 750 }, usualSize: "M" });
      expect(saved.id).toBe("local");
      expect([...m.data.keys()]).toEqual([GUEST_SIZE_PROFILE_KEY]);
      const again = await port.list();
      expect(again[0]?.measurements.height).toBe(1700);
      expect(again[0]?.usualSize).toBe("M");
      await port.remove("local");
      expect(m.data.size).toBe(0);
      expect(calls).toBe(0);
    } finally {
      g.fetch = real;
    }
  });
  it("keeps one profile: a second save replaces it", async () => {
    const m = memory();
    const port = new LocalSizeProfilePort(new SecureStorage(m.backend));
    await port.save({ kind: "me", label: "Me", fitPreference: "regular", modestFit: false, measurements: {}, usualSize: "S" });
    await port.save({ kind: "me", label: "Me", fitPreference: "regular", modestFit: false, measurements: {}, usualSize: "L" });
    expect((await port.list()).map((p) => p.usualSize)).toEqual(["L"]);
  });
});
