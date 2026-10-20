import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const prod = walk(ROOT).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes(join("src", "test")));
const rel = (f: string): string => relative(ROOT, f);
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("security and honesty boundaries", () => {
  it("network access only in api/transport.ts and the server-time countdown", () => {
    const ok = [join("api", "transport.ts"), join("components", "ServerCountdown.tsx")];
    const bad = prod.filter((f) => /\bfetch\s*\(/.test(strip(readFileSync(f, "utf8"))) && !ok.some((o) => f.endsWith(o)));
    expect(bad.map(rel)).toEqual([]);
  });
  it("no any, ts-ignore, non-null assertions or dangerouslySetInnerHTML", () => {
    for (const f of prod) {
      const src = strip(readFileSync(f, "utf8"));
      expect(/:\s*any\b|<any>|\bas any\b/.test(src), `any in ${rel(f)}`).toBe(false);
      expect(/@ts-ignore|@ts-expect-error/.test(src), `ts-ignore in ${rel(f)}`).toBe(false);
      expect(src.includes("dangerouslySetInnerHTML"), `dSIH in ${rel(f)}`).toBe(false);
    }
  });
  it("no inline executable <script> (only the JSON-LD data block) and no style attributes", () => {
    for (const f of prod.filter((x) => x.endsWith(".tsx"))) {
      const src = readFileSync(f, "utf8");
      const scripts = src.match(/<script[\s>][^>]*>/gi) ?? [];
      for (const s of scripts) expect(s, rel(f)).toContain('type="application/ld+json"');
      expect(/\sstyle=\{|\sstyle="/.test(src), `style attr in ${rel(f)}`).toBe(false);
    }
  });
  it("no browser storage, no cookies API, no analytics SDKs", () => {
    for (const f of prod) {
      const src = readFileSync(f, "utf8");
      expect(/localStorage|sessionStorage|document\.cookie|cookies\(\)/.test(src), rel(f)).toBe(false);
      expect(/posthog|sentry|gtag|googletagmanager|fbq\(/i.test(src), rel(f)).toBe(false);
    }
  });
  it("structured data never reads reference price fields", () => {
    const src = readFileSync(join(ROOT, "view-models", "product.ts"), "utf8");
    const ldPart = src.slice(src.indexOf("export function productJsonLd"), src.indexOf("export function organizationJsonLd"));
    expect(/reference_price|discount_pct|priceValidUntil|aggregateRating/.test(ldPart)).toBe(false);
  });
  it("personal fields (is_favorite) are never rendered", () => {
    for (const f of prod.filter((x) => x.endsWith(".tsx"))) expect(readFileSync(f, "utf8").includes("is_favorite"), rel(f)).toBe(false);
  });
});
