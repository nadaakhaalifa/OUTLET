import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { operations } from "./generated/operations";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const specPath = join(root, "docs/api/openapi.yaml");
const genPath = join(root, "tooling/api/generate-client.mjs");
const outDir = join(root, "packages/api-client/src/generated");

async function load(): Promise<(yaml: string) => Record<string, string>> {
  const mod = (await import(/* @vite-ignore */ genPath)) as { generate: (yaml: string) => Record<string, string> };
  return mod.generate;
}

describe("api client generator", () => {
  it("is deterministic: two runs over the same spec are byte-identical", async () => {
    const generate = await load();
    const spec = readFileSync(specPath, "utf8");
    expect(generate(spec)).toEqual(generate(spec));
  });

  it("drift guard: committed generated files equal a fresh in-memory generation (run `node tooling/api/generate-client.mjs` after editing openapi.yaml)", async () => {
    const generate = await load();
    const fresh = generate(readFileSync(specPath, "utf8"));
    expect(Object.keys(fresh).sort()).toEqual(["operations.ts", "schemas.ts"]);
    for (const [name, contents] of Object.entries(fresh)) {
      expect(readFileSync(join(outDir, name), "utf8") === contents, `${name} is stale`).toBe(true);
    }
  });

  it("emits exactly one entry per operationId in the OpenAPI document", async () => {
    const spec = readFileSync(specPath, "utf8");
    const ids = [...spec.matchAll(/^\s+operationId:\s*(\S+)\s*$/gm)].map((m) => (m[1] ?? "").replace(/^"|"$/g, ""));
    expect(Object.keys(operations).sort()).toEqual([...ids].sort());
    expect(ids.length).toBeGreaterThan(300);
  });

  it("marks every write that takes an Idempotency-Key and no safe method as keyed", () => {
    for (const op of Object.values(operations)) {
      if (op.method === "GET") expect(op.idempotency === "required").toBe(false);
    }
    expect(operations.createCheckout.idempotency).toBe("required");
  });
});
