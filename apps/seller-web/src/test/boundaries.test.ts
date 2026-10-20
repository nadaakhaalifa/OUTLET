import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const files = walk(ROOT).filter((f) => /\.(ts|tsx)$/.test(f));
const prod = files.filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes(`${join("src", "test")}`));
const rel = (f: string): string => relative(ROOT, f);

describe("architecture and security boundaries", () => {
  it("fetch( is only used in api/transport.ts", () => {
    const offenders = prod.filter((f) => /\bfetch\s*\(/.test(readFileSync(f, "utf8")) && !f.endsWith(join("api", "transport.ts")));
    expect(offenders.map(rel)).toEqual([]);
  });
  it("no any, ts-ignore, non-null assertions or dangerouslySetInnerHTML in production code", () => {
    for (const f of prod) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(/:\s*any\b|<any>|\bas any\b/.test(src), `any in ${rel(f)}`).toBe(false);
      expect(/@ts-ignore|@ts-expect-error/.test(src), `ts-ignore in ${rel(f)}`).toBe(false);
      expect(/[A-Za-z0-9_)\]]!\s*[.;,)\]]/.test(src.replace(/!==|!=/g, "")), `non-null ! in ${rel(f)}`).toBe(false);
      expect(src.includes("dangerouslySetInnerHTML"), `dSIH in ${rel(f)}`).toBe(false);
    }
  });
  it("no inline <script> and no style attributes (strict CSP)", () => {
    for (const f of prod.filter((x) => x.endsWith(".tsx"))) {
      const src = readFileSync(f, "utf8");
      expect(/<script[\s>]/i.test(src), `script in ${rel(f)}`).toBe(false);
      expect(/\sstyle=\{/.test(src) || /\sstyle="/.test(src), `style attr in ${rel(f)}`).toBe(false);
    }
  });
  it("no localStorage or sessionStorage (tokens stay in the httpOnly cookie)", () => {
    for (const f of prod) expect(/localStorage|sessionStorage/.test(readFileSync(f, "utf8")), rel(f)).toBe(false);
  });
  it("components never import the api client or session directly (only server code and actions do)", () => {
    for (const f of prod.filter((x) => x.includes(join("src", "components")))) {
      const src = readFileSync(f, "utf8");
      expect(/from "\.\.\/api\/(client|transport)"|from "\.\.\/session\//.test(src), rel(f)).toBe(false);
    }
  });
  it("no hard-coded numeric social proof or percent-off copy in catalogs", () => {
    const en = readFileSync(join(ROOT, "i18n/en.ts"), "utf8");
    expect(/\d+\s*(people|viewing|bought|left in stock)/i.test(en)).toBe(false);
    expect(/\d+\s*%\s*off/i.test(en)).toBe(false);
  });
});
