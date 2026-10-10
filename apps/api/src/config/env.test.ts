import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./env";

const PROD_SECRETS = {
  OTP_PEPPER: "p".repeat(32),
  IP_HASH_KEY: "k".repeat(32),
  AGE_BLOCK_KEY: "a".repeat(32),
  DATABASE_URL: "postgres://app@db.invalid/outlet",
  SIZE_DEMAND_PSEUDONYM_KEY: "d".repeat(32),
};

describe("loadConfig", () => {
  it("applies development defaults with in-memory fixtures", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ env: "development", port: 3000, adapters: "in-memory-dev", consentTextVersion: 1 });
  });

  it("coerces and validates numbers", () => {
    expect(loadConfig({ PORT: "8080", TRUST_PROXY_HOPS: "2" })).toMatchObject({ port: 8080, trustProxyHops: 2 });
    expect(() => loadConfig({ PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: "staging" })).toThrow(ConfigError);
  });

  it("refuses dev fixtures in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production", DEV_FIXTURES: "true", ...PROD_SECRETS })).toThrow(/DEV_FIXTURES/);
  });

  it("requires secrets in production and never echoes secret values", () => {
    try {
      loadConfig({ NODE_ENV: "production", DEV_FIXTURES: "false" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues.join(" ")).toMatch(/OTP_PEPPER/);
    }
    try {
      loadConfig({ OTP_PEPPER: "too-short-secret-value" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ConfigError).issues.join(" ")).not.toContain("too-short-secret-value");
    }
  });

  it("requires AGE_BLOCK_KEY in production", () => {
    const { AGE_BLOCK_KEY: _omit, ...without } = PROD_SECRETS;
    expect(() => loadConfig({ NODE_ENV: "production", DEV_FIXTURES: "false", ...without })).toThrow(/AGE_BLOCK_KEY/);
  });

  it("requires the database URL and the demand pseudonym key when fixtures are off", () => {
    const { DATABASE_URL: _u, SIZE_DEMAND_PSEUDONYM_KEY: _k, ...rest } = PROD_SECRETS;
    expect(() => loadConfig({ NODE_ENV: "production", DEV_FIXTURES: "false", ...rest })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ NODE_ENV: "production", DEV_FIXTURES: "false", ...rest, DATABASE_URL: PROD_SECRETS.DATABASE_URL })).toThrow(
      /SIZE_DEMAND_PSEUDONYM_KEY/,
    );
  });

  it("production with secrets and fixtures off selects the (not yet existing) production adapter set", () => {
    expect(loadConfig({ NODE_ENV: "production", DEV_FIXTURES: "false", ...PROD_SECRETS }).adapters).toBe("production");
  });
});
