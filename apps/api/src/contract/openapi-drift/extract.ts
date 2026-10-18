import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const GLOBAL_PREFIX = "v1";
const METHODS = ["get", "put", "post", "delete", "patch", "options", "head"] as const;

/** Canonical key: "METHOD /path" with every param (`{id}` or `:id`) replaced by `{}`. */
export function routeKey(method: string, path: string): string {
  const norm = path
    .replace(/\{[^}]*\}/g, "{}")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "{}")
    .replace(/\/{2,}/g, "/")
    .replace(/(.)\/$/, "$1");
  return `${method.toUpperCase()} ${norm.startsWith("/") ? norm : `/${norm}`}`;
}

export function specRoutes(yamlText: string): Set<string> {
  const doc = parse(yamlText) as { paths?: Record<string, Record<string, unknown>> };
  const out = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const m of METHODS) if (item !== null && typeof item === "object" && m in item) out.add(routeKey(m, path));
  }
  return out;
}

export interface PlannedReport {
  /** Operations that carry `x-status: planned` and a non-empty `x-spec-ref` (ADR-0050). */
  readonly planned: Set<string>;
  /** `x-planned-until` per planned route key (undefined when the marker is missing or not a string). */
  readonly until: Map<string, string | undefined>;
  /** operationId per planned route key. */
  readonly operationIds: Map<string, string>;
  /** Operations with an `x-status` that is not `planned`, or `planned` without an `x-spec-ref`. */
  readonly invalid: string[];
}

/** ADR-0050: an operation may be declared without a controller only as `x-status: planned` plus an `x-spec-ref`. */
export function plannedRoutes(yamlText: string): PlannedReport {
  const doc = parse(yamlText) as { paths?: Record<string, Record<string, unknown>> };
  const planned = new Set<string>();
  const until = new Map<string, string | undefined>();
  const operationIds = new Map<string, string>();
  const invalid: string[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const m of METHODS) {
      const op = item !== null && typeof item === "object" ? (item[m] as Record<string, unknown> | undefined) : undefined;
      if (op === undefined || op === null || typeof op !== "object" || !("x-status" in op)) continue;
      const key = routeKey(m, path);
      const ref = op["x-spec-ref"];
      if (op["x-status"] === "planned" && typeof ref === "string" && ref.trim().length > 0) {
        planned.add(key);
        const u = op["x-planned-until"];
        until.set(key, typeof u === "string" || u instanceof Date ? (u instanceof Date ? u.toISOString().slice(0, 10) : u) : undefined);
        if (typeof op["operationId"] === "string") operationIds.set(key, op["operationId"]);
      } else invalid.push(key);
    }
  }
  return { planned, until, operationIds, invalid: invalid.sort() };
}

const PHASE_LABEL = /^phase-[a-z0-9]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ADR-0050 / spec 12.3: `x-planned-until` is a phase label (`phase-b`) or an ISO date (`2026-12-31`).
 * Phase labels always pass; a date is compared with the clock (injectable `now`) and fails once it is in the past.
 * Returns one message per offending operation, naming the owners.
 */
export function plannedUntilProblems(until: ReadonlyMap<string, string | undefined>, now: Date): string[] {
  const today = now.toISOString().slice(0, 10);
  const out: string[] = [];
  for (const [key, value] of [...until].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (value === undefined) out.push(`${key}: x-planned-until is missing`);
    else if (PHASE_LABEL.test(value)) continue;
    else if (ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      if (value < today) out.push(`${key}: x-planned-until ${value} is in the past (today ${today}); serve it, extend it with Security and the Architect, or remove it`);
    } else out.push(`${key}: x-planned-until "${value}" is neither a phase label (phase-b) nor an ISO date`);
  }
  return out;
}

export interface PlannedEntry {
  readonly operationId: string;
  readonly key: string;
  readonly plannedUntil: string | undefined;
}

/** Parses docs/api/planned-operations.yaml (the allow-list owned by Security and the Architect). */
export function plannedAllowList(yamlText: string): PlannedEntry[] {
  const doc = parse(yamlText) as { operations?: Array<Record<string, unknown>> };
  return (doc.operations ?? []).map((o) => ({
    operationId: String(o["operation_id"]),
    key: routeKey(String(o["method"]), String(o["path"])),
    plannedUntil: typeof o["planned_until"] === "string" ? o["planned_until"] : o["planned_until"] instanceof Date ? o["planned_until"].toISOString().slice(0, 10) : undefined,
  }));
}

/**
 * Routes served by Nest outside any OpenAPI operation that are allowed on purpose (infrastructure probes).
 * Everything else served without a contract operation is an API9 shadow endpoint and fails CI.
 */
export const SHADOW_ALLOW_LIST: ReadonlySet<string> = new Set([
  "GET /v1/health", // liveness probe, deliberately outside the public contract
  "GET /v1/ready", // readiness probe, deliberately outside the public contract
]);

function walk(dir: string, acc: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(name)) acc.push(p);
  }
  return acc;
}

const STR = String.raw`(?:"([^"]*)"|'([^']*)'|\x60([^\x60]*)\x60)`;
const CONTROLLER = new RegExp(String.raw`@Controller\(\s*(?:${STR})?\s*\)`, "g");
const HANDLER = new RegExp(String.raw`^[ \t]*@(Get|Post|Put|Patch|Delete|Options|Head)\(\s*(?:${STR})?\s*\)`, "gm");

/** Routes declared by @Controller/@Get/... decorators, joined with the global prefix. Sorted, deterministic. */
export function controllerRoutes(srcDir: string): Set<string> {
  const out = new Set<string>();
  for (const file of walk(srcDir, []).sort()) {
    const text = readFileSync(file, "utf8");
    const ctrls = [...text.matchAll(CONTROLLER)];
    ctrls.forEach((c, i) => {
      const prefix = c[1] ?? c[2] ?? c[3] ?? "";
      const start = (c.index ?? 0) + c[0].length;
      const end = ctrls[i + 1]?.index ?? text.length;
      for (const h of text.slice(start, end).matchAll(HANDLER)) {
        const sub = h[2] ?? h[3] ?? h[4] ?? "";
        out.add(routeKey(h[1] ?? "get", `/${GLOBAL_PREFIX}/${prefix}/${sub}`));
      }
    });
  }
  return out;
}

export interface DriftReport {
  /** Spec operations with no controller and no valid `planned` marker. */
  unserved: string[];
  /** Served Nest routes with no OpenAPI operation (API9 shadow endpoints), allow-list removed. Fails CI. */
  shadow: string[];
  warnings: string[];
  /** `planned` operations that now have a controller: the marker is stale. Fails CI. */
  plannedNowServed: string[];
}

export function computeDrift(spec: Set<string>, served: Set<string>, planned: ReadonlySet<string> = new Set()): DriftReport {
  return {
    unserved: [...spec].filter((k) => !served.has(k) && !planned.has(k)).sort(),
    shadow: [...served].filter((k) => !spec.has(k) && !SHADOW_ALLOW_LIST.has(k)).sort(),
    warnings: [...served].filter((k) => !spec.has(k)).sort(),
    plannedNowServed: [...planned].filter((k) => served.has(k)).sort(),
  };
}
