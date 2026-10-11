#!/usr/bin/env node
// T9 chaos harness STUB. Asserts, per dependency, what can be asserted TODAY without a running system:
//   (a) the kill switch that gates the degraded mode exists in the feature-flag registry,
//   (b) the flag client fails closed (registry default) when the provider throws or errors, and never throws,
//   (c) a flipped switch is observable through FlagClient.
// Behavioural probes (what the shopper sees) are PENDING until the API exposes them; they are listed, not faked.
// Usage: node tooling/load/chaos/degraded-modes.mjs        (exit 1 on any FAIL; PENDING does not fail)
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as presolve } from "node:path";

if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
registerHooks({
  resolve(spec, ctx, next) {
    if ((spec.startsWith("./") || spec.startsWith("../")) && ctx.parentURL?.endsWith(".ts")) {
      const base = presolve(dirname(fileURLToPath(ctx.parentURL)), spec);
      for (const c of [`${base}.ts`, join(base, "index.ts")]) if (existsSync(c)) return { url: pathToFileURL(c).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const ff = await import(pathToFileURL(join(here, "../../../packages/feature-flags/src/index.ts")).href);
const { FlagClient, InMemoryFlagProvider, KILL_SWITCHES, FLAG_REGISTRY } = ff;

/** One row per T9 chaos test. `switches` are the registry keys that gate the degraded mode; null = none exists (gap). */
const MATRIX = [
  { id: "psp-down", dependency: "PSP", switches: ["kill.payment.card", "kill.payment.apple_pay", "kill.payment.mobile_wallet", "kill.payment.instapay", "kill.payment.fawry", "kill.payment.bnpl"],
    expect: "failover to secondary PSP or hide method; COD and other methods stay; no charge without idempotency key", probe: "GET checkout quote -> payment_methods excludes killed method" },
  { id: "search-down", dependency: "Search engine", switches: null,
    expect: "Postgres FTS/trigram fallback with reduced features, no 5xx on home", probe: "GET /v1/search with engine blocked returns 200 and header X-Search-Mode: fallback (header not yet specified)" },
  { id: "redis-down", dependency: "Redis", switches: ["kill.drops"],
    expect: "waiting room fails CLOSED (drops paused, honest state); normal checkout continues", probe: "POST /v1/drops/{id}/queue -> 503 drop_paused; POST /v1/checkout (non-drop) -> 2xx" },
  { id: "courier-down", dependency: "Courier API", switches: null,
    expect: "orders accepted; AWB creation queued in outbox with retries; wider ETA range", probe: "POST /v1/seller/shipments -> 202 label_pending; outbox depth rises then drains" },
  { id: "llm-down", dependency: "LLM", switches: ["kill.stylist_llm", "kill.ml_ranking"],
    expect: "rule-based stylist; keyword-only search parsing; no P2/P3 sent to a fallback provider", probe: "POST /v1/stylist/outfits -> 200 with source=rules; POST /v1/search/parse -> keyword filters" },
];

let failed = 0;
const line = (st, id, msg) => { if (st === "FAIL") failed += 1; console.log(`${st.padEnd(7)} ${id}: ${msg}`); };

for (const row of MATRIX) {
  if (row.switches === null) {
    line("GAP", row.id, `no kill switch in registry gates this mode (add one or document breaker-only control). expected: ${row.expect}`);
  } else {
    for (const key of row.switches) {
      const def = FLAG_REGISTRY.find((d) => d.key === key);
      if (!(key in KILL_SWITCHES) || def === undefined) { line("FAIL", row.id, `${key} missing from registry`); continue; }
      let threw = false;
      const bad = new InMemoryFlagProvider();
      bad.resolveBooleanEvaluation = () => { threw = true; throw new Error("provider down"); };
      const d = await new FlagClient({ provider: bad }).evaluate(key);
      if (!threw || d.enabled !== def.defaultValue || d.source !== "default_provider_threw") { line("FAIL", row.id, `${key} did not fail closed (${JSON.stringify(d)})`); continue; }
      const ok = new InMemoryFlagProvider({ [key]: true });
      const on = await new FlagClient({ provider: ok }).evaluate(key);
      ok.set(key, false);
      const off = await new FlagClient({ provider: ok }).evaluate(key);
      if (on.enabled !== true || off.enabled !== false) { line("FAIL", row.id, `${key} flip not observable`); continue; }
      line("PASS", row.id, `${key}: exists, fails closed to registry default (${def.defaultValue}), flip observable`);
    }
  }
  line("PENDING", row.id, `behavioural probe not implemented: ${row.probe}`);
}
console.log(failed === 0 ? "harness: no FAIL (GAP/PENDING rows are open work)" : `harness: ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
