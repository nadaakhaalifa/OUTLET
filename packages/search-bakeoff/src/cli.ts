import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MeilisearchAdapter } from "./adapters/meilisearch.js";
import { OpenSearchAdapter } from "./adapters/opensearch.js";
import { TypesenseAdapter } from "./adapters/typesense.js";
import { generateFixtures } from "./fixtures.js";
import { runEngine, summaryTable, type BakeoffQuery, type EngineRun } from "./harness.js";
import { createPgliteFts } from "./pglite.js";
import type { SearchEnginePort } from "./port.js";
import type { Judgment } from "./relevance.js";

const readJsonl = <T>(file: string): T[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);

const main = async (): Promise<void> => {
  const root = process.env.SEARCH_DOCS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../../../docs/search");
  const date = new Date().toISOString().slice(0, 10);
  const queries = readJsonl<BakeoffQuery>(join(root, "queries.v1.jsonl"));
  const judgments = readJsonl<Judgment>(join(root, "judgments.v1.jsonl"));
  const docs = generateFixtures(Number(process.env.SEARCH_BAKEOFF_DOCS ?? 5000));
  const pg = await createPgliteFts();
  const engines: SearchEnginePort[] = [
    pg.adapter,
    new TypesenseAdapter({ baseUrl: process.env.TYPESENSE_URL ?? "http://127.0.0.1:8108" }),
    new MeilisearchAdapter({ baseUrl: process.env.MEILI_URL ?? "http://127.0.0.1:7700" }),
    new OpenSearchAdapter({ baseUrl: process.env.OPENSEARCH_URL ?? "http://127.0.0.1:9200" }),
  ];
  const runs: EngineRun[] = [];
  mkdirSync(join(root, "results"), { recursive: true });
  for (const engine of engines) {
    if (!(await engine.health())) {
      console.log(`engine ${engine.name} not reachable, skipped`);
      continue;
    }
    const run = await runEngine({ engine, docs, queries, judgments, date });
    runs.push(run);
    writeFileSync(join(root, "results", `${date}-${engine.name}.json`), `${JSON.stringify(run, null, 2)}\n`);
  }
  await pg.close();
  const table = summaryTable(runs);
  writeFileSync(join(root, "results", `${date}-summary.md`), `# Bake-off summary ${date}\n\nSynthetic queries and fixtures (see ../README.md).\n\n${table}\n`);
  console.log(table);
};

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
