import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootProduction, type ProductionTestApp } from "./test/test-support";

let booted: ProductionTestApp;
beforeAll(async () => {
  booted = await bootProduction();
}, 120_000);
afterAll(async () => {
  await booted.app.close();
});

const http = () => request(booted.app.getHttpServer());
const MISSING = "0192f3a4-5b6c-7d8e-9f01-0000000000ff";

describe("anonymous catalog reads in the production composition", () => {
  it("are BLOCKED by default (kill.public_catalog is default-off and fails closed) and read nothing", async () => {
    for (const path of [
      "/v1/public/stores",
      `/v1/public/stores/${MISSING}`,
      `/v1/public/products/${MISSING}`,
      "/v1/public/search",
      "/v1/public/sitemap/stores/1",
      "/v1/public/sitemap/products/1",
    ]) {
      const r = await http().get(path);
      expect(r.status, path).toBe(503);
      expect(r.body.code, path).toBe("public_catalog_disabled");
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("leaves the authenticated routes behind a bearer token", async () => {
    for (const path of ["/v1/stores?world=everything", `/v1/stores/${MISSING}`, `/v1/products/${MISSING}`, "/v1/search"]) {
      expect((await http().get(path)).status, path).toBe(401);
    }
  });
});
