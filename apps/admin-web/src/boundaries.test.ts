import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname);
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const sources = walk(root).filter((p) => /\.(ts|tsx)$/.test(p) && !p.endsWith(".test.ts"));

describe("architecture boundaries", () => {
  it("only api/transport.ts calls fetch", () => {
    const offenders = sources.filter((p) => !p.endsWith("api/transport.ts") && /\bfetch\s*\(/.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("no any, ts-ignore or non-null assertions in app code", () => {
    const bad = sources.filter((p) => /:\s*any\b|as any\b|@ts-ignore|@ts-expect-error/.test(readFileSync(p, "utf8")));
    expect(bad).toEqual([]);
  });
  it("uses no dangerouslySetInnerHTML except the nonce-d token stylesheet", () => {
    const hits = sources.filter((p) => readFileSync(p, "utf8").includes("dangerouslySetInnerHTML"));
    expect(hits.map((p) => p.replace(root, ""))).toEqual(["/app/layout.tsx"]);
  });
  it("UI never uses localStorage or sessionStorage for tokens", () => {
    const hits = sources.filter((p) => /localStorage|sessionStorage/.test(readFileSync(p, "utf8")));
    expect(hits).toEqual([]);
  });
});
