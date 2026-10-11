#!/usr/bin/env node
// Seeds a STAGING environment for the k6 scenarios using only documented API endpoints.
//   node tooling/load/seed.mjs                 dry run: prints the plan and writes .data/seed.plan.json
//   node tooling/load/seed.mjs --apply         executes against BASE_URL
// Env: BASE_URL, SELLER_TOKEN (seller:inventory.write), FIXTURES_FILE (JSON from the staging fixture job, see below),
//      RUN_ID (default: timestamp), DROP_UNITS (500), HOT_SKUS (5), HOT_UNITS (100000), CATALOG_UNITS (1000000)
//
// What it does call:   PUT /v1/seller/skus/{skuId}/stock   (Idempotency-Key per SKU+run, so re-running is safe)
// What it cannot do from documented endpoints (needs staging fixtures, hence FIXTURES_FILE):
//   - shopper accounts and bearer tokens (OTP/App Attest path is not scriptable by design)
//   - addresses, checkout quotes (quotes are per user and short-lived: fixtures job refreshes them)
//   - drop creation and queue config (/v1/drops is specified in docs/specs/phase2/07 but not yet in openapi.yaml)
// FIXTURES_FILE shape: { tokens: string[], addressId, productIds: string[], dropQuoteIds: string[],
//   hotSkuQuotes: [{quoteId,total}], webhookTargets: [{orderGroupId, amount}], dropId, dropExpectedTotal }
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, ".data");
const apply = process.argv.includes("--apply");
const runId = process.env.RUN_ID ?? new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const num = (k, d) => Number(process.env[k] ?? d);

/** Deterministic v4-shaped uuid from a label so re-runs address the same SKUs. */
const uuidFor = (label) => {
  const h = createHash("sha256").update(`outlet-load:${label}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const plan = [];
plan.push({ label: "drop-sku", skuId: uuidFor("drop-sku"), quantity: num("DROP_UNITS", 500) });
for (let i = 0; i < num("HOT_SKUS", 5); i += 1) plan.push({ label: `hot-${i}`, skuId: uuidFor(`hot-${i}`), quantity: num("HOT_UNITS", 100000) });
plan.push({ label: "catalog-bulk", skuId: uuidFor("catalog-bulk"), quantity: num("CATALOG_UNITS", 1000000) });

const fixtures = process.env.FIXTURES_FILE ? JSON.parse(readFileSync(process.env.FIXTURES_FILE, "utf8")) : null;
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, "seed.plan.json"), JSON.stringify({ runId, plan }, null, 2));

if (!apply) {
  console.log(`DRY RUN (add --apply). run ${runId}`);
  for (const p of plan) console.log(`  PUT /v1/seller/skus/${p.skuId}/stock  set ${p.quantity}  (${p.label})`);
  process.exit(0);
}

const base = (process.env.BASE_URL ?? "").replace(/\/$/, "");
if (base === "" || process.env.SELLER_TOKEN === undefined) {
  console.error("BASE_URL and SELLER_TOKEN are required with --apply");
  process.exit(2);
}
if (fixtures === null) {
  console.error("FIXTURES_FILE is required with --apply (see header)");
  process.exit(2);
}

for (const p of plan) {
  const res = await fetch(`${base}/v1/seller/skus/${p.skuId}/stock`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${process.env.SELLER_TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": uuidFor(`idem:${runId}:${p.label}`),
    },
    body: JSON.stringify({ mode: "set", quantity: p.quantity, reason: "recount" }),
  });
  if (!res.ok) {
    console.error(`seed failed for ${p.label}: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`seeded ${p.label} -> ${p.quantity} (replayed=${res.headers.get("idempotent-replayed") ?? "false"})`);
}

writeFileSync(join(dataDir, "tokens.json"), JSON.stringify(fixtures.tokens));
writeFileSync(
  join(dataDir, "seed.json"),
  JSON.stringify(
    {
      runId,
      addressId: fixtures.addressId,
      productIds: fixtures.productIds,
      searchTerms: fixtures.searchTerms ?? ["dress", "white linen dress under 1500", "فستان ابيض لينين تحت ١٥٠٠", "fostan", "sneakers 42", "شنطة جلد"],
      hotSkuQuotes: fixtures.hotSkuQuotes,
      webhookTargets: fixtures.webhookTargets,
      drop: { id: fixtures.dropId, quoteIds: fixtures.dropQuoteIds, expectedTotal: fixtures.dropExpectedTotal, skuId: plan[0].skuId, units: plan[0].quantity },
    },
    null,
    2,
  ),
);
console.log(`wrote ${join(dataDir, "seed.json")} and tokens.json (gitignore .data/ before committing)`);
