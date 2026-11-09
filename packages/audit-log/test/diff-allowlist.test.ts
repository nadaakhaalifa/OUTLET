import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Redaction in @outlet/logger is key/pattern based, so it is only a backstop. This test is the allow-list: every audit
 * `append`/`appendIn` call site that writes a `diff:` literal may use only ids, enums, counters, hashes and timestamps as keys.
 * Call sites that build the diff elsewhere (variable, spread) must be listed in INDIRECT with the reason they are safe.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const SAFE_KEY = /^(id|[a-z][A-Za-z]*Id|[a-z]+_id|status|state|severity|kind|type|version|enabled|transition|action|thresholdMinor|allowFreeForAll|hash|[a-z]*Hash|at|[a-z][A-Za-z]*At|[a-z]+_at|before|after)$/u;
/** Reviewed exceptions: file suffix -> keys allowed in addition to SAFE_KEY. */
const EXTRA_KEYS: Readonly<Record<string, readonly string[]>> = {
  // `reason` is the engage/release reason code from a closed set validated at the API boundary (not free text).
  "apps/api/src/modules/admin/ops-services.ts": ["reason"],
  // enums (scope, reason_code, refund_preference), id list and a boolean flag.
  "packages/checkout/src/application/cancellation.ts": ["scope", "reason_code", "seller_order_ids", "refund_preference", "replayed"],
};
/** Files whose diff is passed through from a typed caller; the producers are covered by this same test. */
const INDIRECT: readonly string[] = [
  "apps/api/src/modules/checkout/cancellation-audit.ts",
  "packages/admin-access/src/service.ts",
  "packages/payouts/src/application/payout-service.ts",
  "packages/promotions/src/application/promotion-service.ts",
];

const walk = (dir: string, out: string[] = []): string[] => {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "dist" || n === "test" || n.startsWith(".")) continue;
    const p = `${dir}/${n}`;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
};

const balanced = (s: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return s.slice(open, i + 1);
  }
  return s.slice(open);
};

const keysOf = (literal: string): string[] => [...literal.matchAll(/(?:^|[{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/gu)].map((m) => m[1]!);

const files = [...walk(`${ROOT}apps`).filter((f) => f.includes("/src/")), ...walk(`${ROOT}packages`).filter((f) => f.includes("/src/"))];
const sites = files
  .filter((f) => !f.includes("/audit-log/src/"))
  .map((f) => ({ file: f.slice(ROOT.length), text: readFileSync(f, "utf8") }))
  .filter((x) => /\.append(In)?\(/u.test(x.text) && x.text.includes("diff:"))
  .filter((x) => /(audit|store)\w*\.append(In)?\(|appendIn\(/iu.test(x.text));

describe("audit diff allow-list", () => {
  it("finds the known call sites", () => {
    expect(sites.map((s) => s.file)).toEqual(expect.arrayContaining(["packages/privacy/src/breach.ts", "packages/cart/src/application/cart-service.ts"]));
  });

  for (const s of sites) {
    it(`${s.file}: diff literal keys are ids/enums/hashes/timestamps`, () => {
      const extra = EXTRA_KEYS[s.file] ?? [];
      for (const m of s.text.matchAll(/\bdiff:\s*(?=\{)/gu)) {
        const lit = balanced(s.text, m.index + m[0].length);
        const bad = keysOf(lit).filter((k) => !SAFE_KEY.test(k) && !extra.includes(k));
        expect(bad, `unsafe audit diff keys in ${s.file}`).toEqual([]);
      }
    });
  }

  it("every call site with a non-literal diff is on the reviewed INDIRECT list", () => {
    const nonLiteral = sites.filter((s) => [...s.text.matchAll(/\bdiff:\s*(?!\{)(?!\s*\{)/gu)].length > 0).map((s) => s.file);
    const unreviewed = nonLiteral.filter((f) => !INDIRECT.includes(f) && !/\/(ports|env)\.ts$/u.test(f) && !f.endsWith("deps.ts") && !f.endsWith("cancellation.ts") && !f.endsWith("breach.ts"));
    expect(unreviewed).toEqual([]);
  });

  it("the key check rejects free-text keys (self test)", () => {
    expect(["summary", "note", "phone", "email"].filter((k) => !SAFE_KEY.test(k))).toHaveLength(4);
    expect(keysOf("{ before: { status: a }, after: { openedAt: b, note: c } }")).toEqual(["before", "status", "after", "openedAt", "note"]);
  });
});
