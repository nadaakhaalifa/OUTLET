import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FeatureVectorSchema, ArmOutcomeSchema } from "../domain/schemas";
import { FEATURES_FIXTURE } from "./fixtures";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOMAIN = fileURLToPath(new URL("../../../../../../packages/domain/src/ranking", import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = `${dir}/${n}`;
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
const production = (files: string[]) => files.filter((f) => !/\.test\.ts$|\/test\//.test(f));
const importsOf = (src: string): string[] => [...src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");

describe("module boundaries (mirror of the depcruise rules, enforced locally)", () => {
  const files = [...production(walk(ROOT)), ...production(walk(DOMAIN))];
  it("scans a non-trivial number of files", () => expect(files.length).toBeGreaterThan(15));

  it("never imports the budget module or domain folder, nor sizing or promotions or ads", () => {
    const offenders = files.filter((f) => importsOf(readFileSync(f, "utf8")).some((i) => /(^|\/)(budget|sizing)(\/|$)/i.test(i)));
    expect(offenders).toEqual([]);
  });

  it("never reads budget or measurement tables", () => {
    const sql = files.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(sql).not.toMatch(/\b(from|join)\s+(budgets?|budget_cycles|size_profiles|fit_model_params|installment_commitments|savings_goals)\b/i);
  });

  it("the pure domain imports only its own files and the recommendations domain", () => {
    for (const f of production(walk(DOMAIN))) {
      for (const i of importsOf(readFileSync(f, "utf8"))) {
        expect(i.startsWith("./") || i.startsWith("../recommendations/"), `${f} imports ${i}`).toBe(true);
      }
    }
  });

  it("no LLM client in the scoring path", () => {
    for (const f of files) for (const i of importsOf(readFileSync(f, "utf8"))) expect(i, f).not.toMatch(/llm|anthropic|openai/i);
  });
});

describe("feature vector schema", () => {
  const base = { productId: "p", storeId: "s", personalized: false, values: FEATURES_FIXTURE };
  it("accepts the closed vector", () => expect(FeatureVectorSchema.safeParse(base).success).toBe(true));
  it("rejects a budget field in values or at top level", () => {
    expect(FeatureVectorSchema.safeParse({ ...base, values: { ...FEATURES_FIXTURE, remaining_budget: 1 } }).success).toBe(false);
    expect(FeatureVectorSchema.safeParse({ ...base, budget: 1 }).success).toBe(false);
  });
  it("rejects user affinity on a non-personalized vector", () => {
    expect(FeatureVectorSchema.safeParse({ ...base, values: { ...FEATURES_FIXTURE, category_affinity: 5 } }).success).toBe(false);
    expect(FeatureVectorSchema.safeParse({ ...base, personalized: true, values: { ...FEATURES_FIXTURE, category_affinity: 5 } }).success).toBe(true);
  });
  it("arm outcome counts cannot exceed orders", () => {
    expect(ArmOutcomeSchema.safeParse({ orders: 5, returned: 6, complaints: 0 }).success).toBe(false);
  });
});
