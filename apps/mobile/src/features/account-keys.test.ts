import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resources } from "@outlet/i18n";

const base = join(__dirname);
const dirs = ["plus", "wallet", "gift-cards", "budget", "rewards", "size-profile", "privacy-center", "settings", "help", "legal", "me"];
const lookup = (tree: unknown, key: string): unknown =>
  key.split(".").reduce<unknown>((n, k) => (typeof n === "object" && n !== null ? (n as Record<string, unknown>)[k] : undefined), tree);

describe("account screens use only existing translation keys (AR and EN)", () => {
  const files = [
    ...dirs.flatMap((d) => readdirSync(join(base, d)).filter((f) => f.endsWith(".tsx")).map((f) => join(base, d, f))),
    join(base, "..", "app", "(tabs)", "me.tsx"),
  ];
  for (const lang of ["en", "ar"] as const) {
    it(`static keys resolve in ${lang}`, () => {
      const missing: string[] = [];
      for (const f of files) {
        for (const m of readFileSync(f, "utf8").matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"/g)) {
          const k = m[1] ?? "";
          if (typeof lookup(resources[lang], k) !== "string") missing.push(`${f.split("/").pop()}: ${k}`);
        }
      }
      expect(missing).toEqual([]);
    });
  }
});
