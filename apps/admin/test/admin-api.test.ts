import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminCall } from "../src/client/admin-api";

afterEach(() => vi.unstubAllGlobals());

describe("adminCall idempotency key", () => {
  it("a state-changing call without a key is a type error", () => {
    // @ts-expect-error POST needs idempotencyKey
    const bad = (): unknown => adminCall("eg", "x", { method: "POST" });
    expect(typeof bad).toBe("function");
  });
  it("sends the given key on writes and none on GET", async () => {
    const f = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await adminCall("eg", "x", { method: "POST", idempotencyKey: "k1" });
    await adminCall("eg", "x");
    expect((f.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers["idempotency-key"]).toBe("k1");
    expect((f.mock.calls[1]?.[1] as { headers: Record<string, string> }).headers["idempotency-key"]).toBeUndefined();
  });
  it("every POST call site in the source passes idempotencyKey: uuidv7()", () => {
    const files: string[] = [];
    const walk = (d: string): void => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(p)) files.push(p); } };
    walk(join(__dirname, "../src"));
    let posts = 0;
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      for (const m of s.matchAll(/adminCall\([^;]*?method: "POST"[^;]*?\)\s*;/gs)) { posts++; expect(m[0], f).toContain("idempotencyKey: uuidv7()"); }
    }
    expect(posts).toBeGreaterThanOrEqual(8);
  });
});
