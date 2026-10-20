import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MAX_VALUE_BYTES,
  SECURE_ACCESSIBILITY,
  SecureStorage,
  SecureStorageError,
  STORAGE_KEYS,
  TokenStorage,
  type SecureStoreBackend,
} from "./secure-storage";
import { randomUrlSafeId } from "./random";

function memoryBackend(failing = false) {
  const data = new Map<string, string>();
  const writes: Array<{ key: string; accessibility: string }> = [];
  const backend: SecureStoreBackend = {
    async getItemAsync(k) {
      if (failing) throw new Error("boom");
      return data.get(k) ?? null;
    },
    async setItemAsync(k, v, o) {
      if (failing) throw new Error("boom");
      writes.push({ key: k, accessibility: o.accessibility });
      data.set(k, v);
    },
    async deleteItemAsync(k) {
      data.delete(k);
    },
  };
  return { backend, data, writes };
}

describe("SecureStorage", () => {
  it("always writes with WHEN_UNLOCKED_THIS_DEVICE_ONLY", async () => {
    const m = memoryBackend();
    const s = new SecureStorage(m.backend);
    await s.setString("a.b", "x");
    await s.setJson("c", { n: 1 });
    expect(SECURE_ACCESSIBILITY).toBe("WHEN_UNLOCKED_THIS_DEVICE_ONLY");
    expect(m.writes.every((w) => w.accessibility === "WHEN_UNLOCKED_THIS_DEVICE_ONLY")).toBe(true);
    expect(m.writes).toHaveLength(2);
  });
  it("rejects invalid keys and oversized values", async () => {
    const s = new SecureStorage(memoryBackend().backend);
    await expect(s.setString("bad key!", "x")).rejects.toMatchObject({ code: "invalid_key" });
    await expect(s.setString("k", "x".repeat(MAX_VALUE_BYTES + 1))).rejects.toMatchObject({ code: "value_too_large" });
  });
  it("wraps backend failure in a typed error", async () => {
    const s = new SecureStorage(memoryBackend(true).backend);
    await expect(s.getString("k")).rejects.toBeInstanceOf(SecureStorageError);
  });
  it("deletes and ignores corrupt or schema-mismatched values", async () => {
    const m = memoryBackend();
    const s = new SecureStorage(m.backend);
    m.data.set("k", "{not json");
    expect(await s.getJson("k", z.object({ a: z.number() }))).toBeNull();
    expect(m.data.has("k")).toBe(false);
    m.data.set("k", JSON.stringify({ a: "x" }));
    expect(await s.getJson("k", z.object({ a: z.number() }))).toBeNull();
    expect(m.data.has("k")).toBe(false);
  });
  it("stores and clears tokens, refusing malformed ones", async () => {
    const m = memoryBackend();
    const t = new TokenStorage(new SecureStorage(m.backend));
    const tokens = { accessToken: "a", refreshToken: "r", accessExpiresAtMs: 5 };
    await t.save(tokens);
    expect(m.data.has(STORAGE_KEYS.tokens)).toBe(true);
    expect(await t.load()).toEqual(tokens);
    await t.clear();
    expect(await t.load()).toBeNull();
    await expect(t.save({ accessToken: "", refreshToken: "r", accessExpiresAtMs: 1 })).rejects.toThrow();
  });
});

describe("randomUrlSafeId", () => {
  it("throws without a CSPRNG and never falls back to Math.random", () => {
    expect(() => randomUrlSafeId(16, {})).toThrow();
  });
  it("produces URL-safe output of the requested length", () => {
    const id = randomUrlSafeId(24, { getRandomValues: (a) => a.map((_, i) => i * 7) });
    expect(id).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
});
