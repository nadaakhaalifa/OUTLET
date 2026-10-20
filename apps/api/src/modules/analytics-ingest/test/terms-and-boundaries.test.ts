import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StaticVocabulary } from "../adapters/in-memory";
import { MAX_TERM_CHARS, classifyTerm, normaliseTerm, tokensOf } from "../domain/terms";
import { deterministicEventId } from "../domain/events";
import { findForbiddenKey, isForbiddenKey } from "../domain/client-events";
import { AnalyticsProducers } from "../domain/producers";
import { FakeKeyer, StaticGate } from "../adapters/in-memory";

const vocab = new StaticVocabulary(new Set(["dress", "linen", "white", "فستان"]));
const hash = (t: string) => `h(${t})`;

describe("classifyTerm", () => {
  it("normalises (NFKC, case, whitespace) before deciding", async () => {
    expect(normaliseTerm("  White   LINEN ")).toBe("white linen");
    expect(tokensOf("white, linen-dress")).toEqual(["white", "linen", "dress"]);
    expect(await classifyTerm("  White   LINEN ", vocab, hash)).toEqual({ kind: "vocabulary", term: "white linen" });
  });
  it("hashes anything with a non-vocabulary token (a name never reaches storage in clear)", async () => {
    expect(await classifyTerm("dress Mariam", vocab, hash)).toEqual({ kind: "hashed", termHash: "h(dress mariam)" });
    expect(await classifyTerm("مريم", vocab, hash)).toMatchObject({ kind: "hashed" });
  });
  it("rejects PII shapes, short and overlong terms", async () => {
    for (const t of ["0100 123 4567", "+20 100 123 4567", "a@b.co", "www.x.test", "٠١٠٠١٢٣٤٥٦٧", "id 29001011234567"]) {
      expect(await classifyTerm(t, vocab, hash), t).toEqual({ kind: "rejected", reason: "pii_shape" });
    }
    expect(await classifyTerm("ab", vocab, hash)).toEqual({ kind: "rejected", reason: "too_short" });
    expect(await classifyTerm("x".repeat(MAX_TERM_CHARS + 1), vocab, hash)).toEqual({ kind: "rejected", reason: "too_long" });
  });
});

describe("forbidden keys", () => {
  it("matches the spec list and the budget_ prefix, case-insensitively, at any depth", () => {
    for (const k of ["user_id", "phone", "email", "address", "dob", "measurements", "budget_total", "BUDGET_x", "User_Id"]) expect(isForbiddenKey(k), k).toBe(true);
    for (const k of ["product_id", "budget", "store_id", "term"]) expect(isForbiddenKey(k), k).toBe(false);
    expect(findForbiddenKey({ events: [{ properties: { nested: { dob: 1 } } }] })).toBe("dob");
    expect(findForbiddenKey({ events: [{ properties: { a: 1 } }] })).toBeNull();
  });
});

describe("producers: amounts and ids", () => {
  const p = new AnalyticsProducers({ gate: new StaticGate(true), keyer: new FakeKeyer() });
  const line = (unit: bigint, qty: number, disc: bigint) => ({
    orderLineId: "00000000-0000-4000-8000-000000000001", productId: "00000000-0000-4000-8000-000000000002",
    skuId: "00000000-0000-4000-8000-000000000003", qty, unitPriceMinor: unit, discountAllocMinor: disc, sizeLabel: null,
  });
  const args = { userId: "u", consented: true, sellerOrderId: "00000000-0000-4000-8000-000000000004", storeId: "00000000-0000-4000-8000-000000000005", governorate: null, purchasedAtMs: 1_800_000_000_000 };

  it("gross = unit x qty - discount, commission banker-rounded, both as integer strings (property over a deterministic grid)", () => {
    let checked = 0;
    for (const unit of [1n, 5n, 15n, 9_999n, 25_000n, 9_007_199_254_740_993n]) {
      for (const qty of [1, 2, 7]) {
        for (const disc of [0n, 1n, 500n]) {
          for (const bps of [0, 1_000, 1_500, 10_000]) {
            const d = p.orderLinePurchased({ ...args, commissionRateBps: bps, line: line(unit, qty, disc) });
            const gross = unit * BigInt(qty) - disc;
            if (gross < 0n) continue;
            const payload = d?.payload as { gross_minor: string; commission_minor: string };
            expect(payload.gross_minor).toBe(gross.toString());
            const exact = gross * BigInt(bps);
            const q = exact / 10_000n;
            const r = exact % 10_000n;
            const even = r > 5_000n || (r === 5_000n && q % 2n === 1n) ? q + 1n : q;
            expect(payload.commission_minor).toBe(even.toString());
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("a discount larger than the gross clamps to zero instead of producing a negative amount", () => {
    const d = p.orderLinePurchased({ ...args, commissionRateBps: 1_500, line: line(100n, 1, 500n) });
    expect((d?.payload as { gross_minor: string }).gross_minor).toBe("0");
  });

  it("an invalid payload is skipped (null), never thrown into the money transaction", () => {
    expect(p.orderLinePurchased({ ...args, storeId: "not-a-uuid", commissionRateBps: 1_500, line: line(100n, 1, 0n) })).toBeNull();
    expect(p.sellerOrderPlaced({ userId: "u", consented: true, placedAtMs: 0, lines: [] })).toEqual({});
  });

  it("event ids are deterministic and differ per key", () => {
    expect(deterministicEventId("t", "k")).toBe(deterministicEventId("t", "k"));
    expect(deterministicEventId("t", "k")).not.toBe(deterministicEventId("t", "k2"));
    expect(deterministicEventId("t", "k")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

const ROOT = fileURLToPath(new URL("..", import.meta.url));
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const q = `${dir}/${n}`;
    return statSync(q).isDirectory() ? walk(q) : q.endsWith(".ts") ? [q] : [];
  });
}
const production = (files: string[]) => files.filter((f) => !/\.test\.ts$|\/test\//.test(f));
const importsOf = (src: string): string[] => [...src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");

describe("module boundaries (mirror of the depcruise rules, enforced locally)", () => {
  const files = production(walk(ROOT));
  it("scans a non-trivial number of files", () => {
    expect(files.length).toBeGreaterThan(10);
  });
  it("never imports budget, sizing measurements or personalisation modules", () => {
    const bad = files.filter((f) => importsOf(readFileSync(f, "utf8")).some((i) => /(^|\/)(budget|sizing|history|recommendations|ranking|stylist)(\/|$)/.test(i)));
    expect(bad).toEqual([]);
  });
  it("never reads budget, measurement or per-shopper tables in SQL", () => {
    const sql = files.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(sql).not.toMatch(/\b(from|join)\s+(budgets?|budget_cycles|size_profiles|fit_model_params|installment_commitments|savings_goals)\b/i);
  });
  it("writes only to outbox_events (no write to any other table)", () => {
    const sql = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const writes = [...sql.matchAll(/\b(insert\s+into|update|delete\s+from)\s+([a-z_]+)/gi)].map((m) => (m[2] ?? "").toLowerCase());
    expect(new Set(writes)).toEqual(new Set(["outbox_events"]));
  });
  it("the ingest path stores no raw user id in a payload", () => {
    const uc = readFileSync(`${ROOT}/application/ingest-batch.ts`, "utf8");
    expect(uc).not.toMatch(/user_id|userId\s*[:,]\s*input/);
  });
});
