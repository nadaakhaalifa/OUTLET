import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { PG_PROCESS_NAMES } from "@outlet/observability";
import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/config.js";
import { pgPoolOptions } from "../src/platform/db.js";

/**
 * cli.ts is a composition root with top-level side effects (it listens on a port and connects to Postgres/Redis),
 * so it cannot run against PGlite. These tests pin down what a boot needs: the config loads, the runtime has
 * KeyObject.toCryptoKey (Node 24), and the pools carry their ADR-0011 tags. The wired parts are tested elsewhere.
 */
/** Same parameters as cli.ts; the JOSE name "ES256" is rejected by KeyObject.toCryptoKey (found by this test). */
const ES256_PARAMS = { name: "ECDSA", namedCurve: "P-256" } as const;
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const BASE = {
  DATABASE_URL_APP: "postgres://app@pgbouncer:6432/outlet_catalog",
  JWT_ISSUER: "https://auth.outlex.test",
  JWT_KID: "k1",
  JWT_PUBLIC_KEY_PEM: keys.publicKey.export({ type: "spki", format: "pem" }),
  JWT_PRIVATE_KEY_PEM: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
  RATE_LIMIT_KEY_SECRET: "s".repeat(32),
};

describe("api boot prerequisites", () => {
  it("engines.node requires >= 24, where KeyObject.toCryptoKey exists", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toMatch(/^>=\s*(2[4-9]|[3-9]\d)/);
    expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(24);
    expect(typeof createPrivateKey(BASE.JWT_PRIVATE_KEY_PEM).toCryptoKey).toBe("function");
  });

  it("loads the config and turns the PEMs into WebCrypto keys exactly like cli.ts", () => {
    const env = parseEnv(BASE);
    const priv = createPrivateKey(env.JWT_PRIVATE_KEY_PEM).toCryptoKey(ES256_PARAMS, false, ["sign"]);
    const pub = createPublicKey(env.JWT_PUBLIC_KEY_PEM).toCryptoKey(ES256_PARAMS, true, ["verify"]);
    expect([priv.type, pub.type]).toEqual(["private", "public"]);
    expect(env.PORT).toBe(8080);
  });

  it("production needs Redis and the outlet_auth pool URL; error names variables, never values", () => {
    const prod = { ...BASE, NODE_ENV: "production" };
    expect(() => parseEnv(prod)).toThrow(/REDIS_URL/);
    expect(() => parseEnv({ ...prod, REDIS_URL: "rediss://r:6379" })).toThrow(/DATABASE_URL_AUTH/);
    const ok = parseEnv({ ...prod, REDIS_URL: "rediss://r:6379", DATABASE_URL_AUTH: "postgres://auth@pgbouncer:6432/outlet_auth" });
    expect(ok.DATABASE_URL_AUTH).toContain("outlet_auth");
    try {
      parseEnv({ ...prod, RATE_LIMIT_KEY_SECRET: "short" });
    } catch (e) {
      expect(String(e)).not.toContain("short");
    }
  });

  it("pools are tagged per ADR-0011: auth and worker are known process names", () => {
    expect(PG_PROCESS_NAMES).toEqual(expect.arrayContaining(["auth", "worker", "catalog.read"]));
    expect(pgPoolOptions("postgres://x@h/db", "auth", 5)).toMatchObject({ application_name: "auth", max: 5 });
    expect(() => pgPoolOptions("postgres://x@h/db", "bogus" as never, 5)).toThrow(/unknown pg process name/);
  });
});
