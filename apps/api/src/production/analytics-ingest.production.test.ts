import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { MODULE_BINDINGS } from "./bindings";
import { bootProduction, type ProductionTestApp } from "./test/test-support";
import { IngestDisabledError, type IngestAnalyticsBatch } from "../modules/analytics-ingest";
import { ProviderNotConfiguredError, unconfigured } from "./unconfigured";
import { VerifierAttestationCheck } from "../modules/analytics-ingest";
import type { AttestationVerifier } from "@outlet/auth-core";


describe("analytics-ingest under the production composition (ADR-0029)", () => {
  let t: ProductionTestApp;
  beforeAll(async () => {
    t = await bootProduction();
  }, 120_000);
  afterAll(async () => {
    await t.app.close();
  });

  it("is composed, with honest gaps", () => {
    const b = MODULE_BINDINGS["analytics-ingest"];
    expect(b?.status).toBe("composed");
    expect(b?.status === "composed" ? b.gaps : "").toContain("attestation");
  });

  it("the route is mounted and refuses an unauthenticated caller (401, not 404)", async () => {
    const r = await request(t.app.getHttpServer()).post("/v1/analytics/events").send({});
    expect(r.status).toBe(401);
  });

  it("an Unconfigured attestation verifier is a 503, never 'device untrusted'", async () => {
    const check = new VerifierAttestationCheck(unconfigured<AttestationVerifier>("attestation.app-attest"));
    await expect(check.verify("ios", "x")).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it("kill.analytics.ingest is blocked by default: the use case refuses before reading anything", async () => {
    const { ANALYTICS_INGEST_USE_CASE: token } = await import("../modules/analytics-ingest/adapters/tokens");
    const uc = t.app.get<IngestAnalyticsBatch>(token, { strict: false });
    await expect(
      uc.execute({ userId: "u", attestation: { platform: "ios", token: "t" }, body: {}, nowMs: 0, batchId: "b" }),
    ).rejects.toBeInstanceOf(IngestDisabledError);
  });
});
