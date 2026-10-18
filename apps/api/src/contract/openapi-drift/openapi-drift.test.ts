import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeDrift, controllerRoutes, plannedAllowList, plannedRoutes, plannedUntilProblems, SHADOW_ALLOW_LIST, specRoutes } from "./extract";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../..");
/** Override with OPENAPI_DRIFT_SPEC to point at a temp copy (used for the negative-case proof). */
const SPEC = process.env["OPENAPI_DRIFT_SPEC"] ?? resolve(here, "../../../../../docs/api/openapi.yaml");
const PLANNED_FILE = process.env["OPENAPI_DRIFT_PLANNED"] ?? resolve(here, "../../../../../docs/api/planned-operations.yaml");
const BASELINE = resolve(here, "unserved-baseline.json");

/** Injectable clock: x-planned-until dates are compared with this, never with a hidden Date.now(). */
const now = (): Date => new Date(process.env["OPENAPI_DRIFT_NOW"] ?? Date.now());

const baseline = (JSON.parse(readFileSync(BASELINE, "utf8")) as { unserved: string[] }).unserved;
const specText = readFileSync(SPEC, "utf8");
const spec = specRoutes(specText);
const { planned, until, operationIds, invalid: invalidPlanned } = plannedRoutes(specText);
const served = controllerRoutes(SRC);
const { unserved, shadow, plannedNowServed } = computeDrift(spec, served, planned);

describe("OpenAPI drift ratchet", () => {
  it("every spec path+method is served by a controller, except baselined gaps and planned operations", () => {
    const fresh = unserved.filter((k) => !baseline.includes(k));
    expect(fresh, `NEW unserved OpenAPI operations without a planned marker (do not baseline without a recorded reason):\n${fresh.join("\n")}`).toEqual([]);
  });

  it("baseline only shrinks: no baselined entry is now served or gone from the spec", () => {
    const stale = baseline.filter((k) => !unserved.includes(k));
    expect(stale, `Baseline entries now served/removed; delete them from unserved-baseline.json:\n${stale.join("\n")}`).toEqual([]);
  });

  it("a planned operation carries x-status: planned and a non-empty x-spec-ref (ADR-0050)", () => {
    expect(invalidPlanned, `x-status must be exactly "planned" and needs an x-spec-ref:\n${invalidPlanned.join("\n")}`).toEqual([]);
  });

  it("a planned operation is not also baselined (planned replaces the baseline entry)", () => {
    const both = baseline.filter((k) => planned.has(k));
    expect(both, `Remove from unserved-baseline.json (already marked planned in the OpenAPI):\n${both.join("\n")}`).toEqual([]);
  });

  it("a planned operation must not have a Nest route: remove x-status and its planned-operations.yaml entry in the same PR", () => {
    expect(plannedNowServed, `Planned operations that are now served:\n${plannedNowServed.join("\n")}`).toEqual([]);
  });

  it("a served Nest route without an OpenAPI operation fails (API9 shadow endpoint); only the probes are allow-listed", () => {
    expect(shadow, `Controller routes with no OpenAPI operation (add the contract, do not extend the allow-list):\n${shadow.join("\n")}`).toEqual([]);
    expect([...SHADOW_ALLOW_LIST].sort()).toEqual(["GET /v1/health", "GET /v1/ready"]);
    expect(served.size).toBeGreaterThan(0);
  });

  it("x-planned-until is present and not in the past (phase labels pass; dates compare with the clock)", () => {
    const problems = plannedUntilProblems(until, now());
    expect(problems, `Expired or malformed x-planned-until (owners: Security and the Architect):\n${problems.join("\n")}`).toEqual([]);
  });

  it("baseline is sorted and unique", () => {
    expect(baseline).toEqual([...new Set(baseline)].sort());
  });
});

describe("planned-operations.yaml allow-list", () => {
  const entries = plannedAllowList(readFileSync(PLANNED_FILE, "utf8"));

  it("lists every x-status: planned operation and nothing else (both directions)", () => {
    const listed = new Map(entries.map((e) => [e.key, e.operationId]));
    const missing = [...planned].filter((k) => !listed.has(k)).sort();
    const stale = [...listed.keys()].filter((k) => !planned.has(k)).sort();
    expect({ missingFromAllowList: missing, notPlannedInOpenApi: stale }).toEqual({ missingFromAllowList: [], notPlannedInOpenApi: [] });
    const wrongId = [...listed].filter(([k, id]) => operationIds.get(k) !== id).map(([k, id]) => `${k}: ${id} vs ${operationIds.get(k) ?? "?"}`);
    expect(wrongId).toEqual([]);
  });

  it("entries are sorted by operationId, unique, and agree with the OpenAPI x-planned-until", () => {
    const ids = entries.map((e) => e.operationId);
    expect(ids).toEqual([...new Set(ids)].sort());
    const mismatch = entries.filter((e) => until.get(e.key) !== e.plannedUntil).map((e) => `${e.key}: yaml ${String(e.plannedUntil)} vs openapi ${String(until.get(e.key))}`);
    expect(mismatch).toEqual([]);
  });
});

describe("ratchet logic (negative proofs on synthetic input)", () => {
  it("a planned operation that gains a route is reported", () => {
    const r = computeDrift(new Set(["GET /v1/a"]), new Set(["GET /v1/a"]), new Set(["GET /v1/a"]));
    expect(r.plannedNowServed).toEqual(["GET /v1/a"]);
  });

  it("a served route with no operation is a shadow endpoint unless allow-listed", () => {
    const r = computeDrift(new Set(), new Set(["GET /v1/secret", "GET /v1/health"]), new Set());
    expect(r.shadow).toEqual(["GET /v1/secret"]);
  });

  it("an unserved operation without a marker is reported", () => {
    expect(computeDrift(new Set(["GET /v1/a"]), new Set(), new Set()).unserved).toEqual(["GET /v1/a"]);
  });

  it("x-planned-until: phase labels pass, a past date fails, today and the future pass, junk and missing fail", () => {
    const at = new Date("2026-10-16T12:00:00Z");
    const u = new Map<string, string | undefined>([
      ["GET /v1/a", "phase-b"],
      ["GET /v1/b", "2026-10-15"],
      ["GET /v1/c", "2026-10-16"],
      ["GET /v1/d", "2027-01-01"],
      ["GET /v1/e", "soon"],
      ["GET /v1/f", undefined],
    ]);
    const msgs = plannedUntilProblems(u, at);
    expect(msgs.map((m) => m.split(":")[0])).toEqual(["GET /v1/b", "GET /v1/e", "GET /v1/f"]);
    expect(plannedUntilProblems(u, new Date("2026-10-17T00:00:00Z")).map((m) => m.split(":")[0])).toContain("GET /v1/c");
  });
});
