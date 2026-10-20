import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard: a worklet (useAnimatedStyle / useAnimatedReaction / useDerivedValue / useAnimatedScrollHandler /
 * useAnimatedProps callback) that calls a plain JS helper imported from ../logic throws
 * "[Worklets] Tried to synchronously call a Remote Function" on the UI runtime, which aborts Expo Go natively (SIGABRT).
 * Logic helpers are the tested twins; worklets must inline the math. Constants (no call) are fine.
 */
const DIR = __dirname;
const HOOKS = /\b(useAnimatedStyle|useAnimatedReaction|useDerivedValue|useAnimatedScrollHandler|useAnimatedProps)\s*\(/g;

function balancedArgs(src: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(openParen + 1, i);
    }
  }
  return src.slice(openParen + 1);
}

function logicImports(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\.\/logic[^"']*["']/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (name && !part.trim().startsWith("type ")) names.push(name);
    }
  }
  return names;
}

describe("worklets never call plain JS logic helpers", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".tsx"));
  it.each(files)("%s", (file) => {
    const src = readFileSync(join(DIR, file), "utf8");
    const helpers = logicImports(src);
    const offenders: string[] = [];
    for (const m of src.matchAll(HOOKS)) {
      const body = balancedArgs(src, (m.index ?? 0) + m[0].length - 1);
      for (const h of helpers) if (new RegExp(`\\b${h}\\s*\\(`).test(body)) offenders.push(`${m[1]} -> ${h}()`);
    }
    expect(offenders).toEqual([]);
  });
});
