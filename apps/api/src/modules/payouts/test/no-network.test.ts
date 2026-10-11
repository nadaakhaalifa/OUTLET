import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith(".ts") && !p.includes(".test.") && !p.includes("/test/") ? [p] : [];
  });
}

describe("no live network calls (hard limit)", () => {
  it("no non-test source uses a network API or an HTTP client", () => {
    const banned = /\b(fetch\s*\(|XMLHttpRequest|WebSocket|axios|undici|node-fetch|got\s*\(|from\s+["']node:(http|https|net|tls|dgram|dns)["']|require\(["'](http|https|net)["']\))/;
    const offenders = sources(ROOT).filter((f) => banned.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
