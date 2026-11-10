import { TypesenseEngine, UnconfiguredSearchEngine } from "@outlet/search";
import { describe, expect, it } from "vitest";
import { parseWorkerEnv } from "../src/worker/config.js";
import { selectSearchEngine } from "../src/worker/jobs.js";

const base = { DATABASE_URL_WORKER: "postgres://w@localhost/db", DATABASE_URL_APP: "postgres://a@localhost/db" };

describe("search engine selection by env (ADR-0017)", () => {
  it("is Unconfigured unless both variables are set", () => {
    expect(selectSearchEngine(parseWorkerEnv(base))).toBeInstanceOf(UnconfiguredSearchEngine);
    expect(selectSearchEngine(parseWorkerEnv({ ...base, SEARCH_TYPESENSE_URL: "http://ts:8108" }))).toBeInstanceOf(UnconfiguredSearchEngine);
    expect(selectSearchEngine(parseWorkerEnv({ ...base, SEARCH_TYPESENSE_API_KEY: "abcdefgh12" }))).toBeInstanceOf(UnconfiguredSearchEngine);
  });
  it("is TypesenseEngine when both are set, and a bad URL or short key fails boot without echoing values", () => {
    const e = selectSearchEngine(parseWorkerEnv({ ...base, SEARCH_TYPESENSE_URL: "http://ts:8108", SEARCH_TYPESENSE_API_KEY: "abcdefgh12" }));
    expect(e).toBeInstanceOf(TypesenseEngine);
    expect(e.configured).toBe(true);
    expect(() => parseWorkerEnv({ ...base, SEARCH_TYPESENSE_URL: "ftp://x", SEARCH_TYPESENSE_API_KEY: "short" })).toThrow(/SEARCH_TYPESENSE_URL.*SEARCH_TYPESENSE_API_KEY|SEARCH_TYPESENSE/);
    try { parseWorkerEnv({ ...base, SEARCH_TYPESENSE_URL: "http://ts", SEARCH_TYPESENSE_API_KEY: "short" }); } catch (x) { expect(String(x)).not.toContain("short"); }
  });
});
