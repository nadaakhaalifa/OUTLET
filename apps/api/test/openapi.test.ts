import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CONTROLLERS } from "../src/controllers.js";
import { buildOpenApi } from "../src/openapi/generate.js";
import { renderOpenApi } from "../src/openapi/render.js";
import { collectRoutes, routeKey } from "../src/platform/route-registry.js";
import { ProbeController } from "./probe.controller.js";

const file = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const ROUTES = collectRoutes(CONTROLLERS);
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

interface Op {
  operationId?: string;
  security?: unknown[];
  parameters?: ({ $ref?: string; name?: string; in?: string } | undefined)[];
  "x-rate-limit"?: unknown;
  "x-authz"?: { principal?: string };
}
interface Doc {
  paths: Record<string, Partial<Record<(typeof METHODS)[number], Op>>>;
}

const ops = (doc: Doc): [string, Op][] =>
  Object.entries(doc.paths).flatMap(([p, item]) => METHODS.flatMap((m) => (item[m] === undefined ? [] : [[`${m.toUpperCase()} ${p}`, item[m]] as [string, Op]])));
const refs = (op: Op): string[] => (op.parameters ?? []).map((p) => p?.$ref ?? `${p?.in ?? ""}:${p?.name ?? ""}`);

const Todo = z.strictObject({ $comment: z.string(), operations: z.array(z.string().regex(/^(GET|POST|PUT|PATCH|DELETE) \/v1\//)) });

describe("generated OpenAPI", () => {
  const all = ops(buildOpenApi([...ROUTES, ...collectRoutes([ProbeController])]) as unknown as Doc);

  it("every operation has a security requirement (public = empty list) and an x-rate-limit", () => {
    for (const [k, op] of all) {
      expect(Array.isArray(op.security), k).toBe(true);
      expect(op.security?.length === 0, k).toBe(op["x-authz"]?.principal === "anonymous");
      expect(op["x-rate-limit"], k).toBeDefined();
    }
  });

  it("every mutation takes Idempotency-Key unless it is a declared pure POST; every list takes cursor + limit", () => {
    const routes = new Map([...ROUTES, ...collectRoutes([ProbeController])].map((r) => [routeKey(r), r]));
    for (const [k, op] of all) {
      const r = routes.get(k);
      const mutating = !k.startsWith("GET ");
      expect(refs(op).includes("#/components/parameters/IdempotencyKey"), k).toBe(mutating && r?.noIdempotency === undefined);
      if (r?.paginated === true) expect(refs(op), k).toEqual(expect.arrayContaining(["#/components/parameters/Cursor", "#/components/parameters/Limit"]));
    }
  });

  it("apps/api/openapi.generated.yaml is up to date (run: pnpm --filter api openapi)", async () => {
    expect(await readFile(file("../openapi.generated.yaml"), "utf8")).toBe(renderOpenApi(ROUTES));
  });
});

describe("coverage against the contract docs/api/openapi.yaml", async () => {
  const contract = parse(await readFile(file("../../../docs/api/openapi.yaml"), "utf8")) as Doc;
  const contractOps = new Map(ops(contract));
  const todo = Todo.parse(JSON.parse(await readFile(file("../openapi.todo.json"), "utf8"))).operations;
  const served = new Map(ops(buildOpenApi(ROUTES) as unknown as Doc));
  // Infrastructure probes, plus implementation-only operations the contract does not describe yet (it models the device inline in each auth body;
// the API registers it once and carries the id in X-Device-Id). Listed here so they cannot grow silently.
const global = new Set(["GET /v1/health/live", "GET /v1/health/ready", "POST /v1/{market}/auth/devices"]);

  it("every contract operation is served or listed in openapi.todo.json", () => {
    expect([...contractOps.keys()].filter((k) => !served.has(k) && !todo.includes(k))).toEqual([]);
  });

  it("openapi.todo.json has no stale (served) or unknown entries, and no duplicates", () => {
    expect(todo.filter((k) => served.has(k))).toEqual([]);
    expect(todo.filter((k) => !contractOps.has(k))).toEqual([]);
    expect(new Set(todo).size).toBe(todo.length);
  });

  it("every served operation is in the contract (except infrastructure probes)", () => {
    expect([...served.keys()].filter((k) => !contractOps.has(k) && !global.has(k))).toEqual([]);
  });

  it("served operations agree with the contract: operationId, public vs authenticated, idempotency, pagination", () => {
    for (const [k, ours] of served) {
      const theirs = contractOps.get(k);
      if (theirs === undefined) continue;
      expect(ours.operationId, k).toBe(theirs.operationId);
      // A contract security list that includes the empty requirement ({}) means "anonymous, or signed in for extras". We serve
      // such routes as public (credentials are ignored, so nothing member-only can leak) until optional auth exists.
      const optionalAuth = theirs.security?.some((s) => typeof s === "object" && s !== null && Object.keys(s).length === 0) === true;
      // Provider webhooks declare the `webhookHmac` scheme: no user token exists, so they are served as @Public and authenticated by IP allow-list + HMAC in the handler.
      const sec = theirs.security ?? [];
      const hmacOnly = sec.length > 0 && sec.every((s) => typeof s === "object" && s !== null && Object.keys(s).every((n) => n === "webhookHmac"));
      expect(ours.security?.length === 0, `${k} public`).toBe(theirs.security?.length === 0 || optionalAuth || hmacOnly);
      for (const ref of ["#/components/parameters/IdempotencyKey", "#/components/parameters/StoreScope", "#/components/parameters/Cursor", "#/components/parameters/Limit"]) {
        expect(refs(ours).includes(ref), `${k} ${ref}`).toBe(refs(theirs).includes(ref));
      }
    }
  });
});
