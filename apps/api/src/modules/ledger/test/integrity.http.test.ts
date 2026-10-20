import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, Grant } from "@outlet/policy";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import {
  AUDIT_SINK,
  AUTHENTICATOR,
  PlatformModule,
  createIdGenerator,
  nodeCsprng,
  type Authenticator,
  type InMemoryAuditSink,
} from "../../../platform";
import { InMemoryIntegrityRuns } from "../adapters/in-memory-integrity";
import { InMemoryLedger, InMemoryProjection } from "../adapters/in-memory";
import { LedgerModule } from "../ledger.module";
import { FakeClock, driftRow, failedReport, okReport, recorderFor, uid } from "./integrity-fixtures";

const clock = new FakeClock(Date.UTC(2026, 9, 29, 6, 0));
type Aud = AccessClaims["aud"];
const principal = (n: number, token: string, grants: Grant[], aud: Aud = "admin_api", assurance: Actor["assurance"] = "passkey") => ({
  token,
  aud,
  actor: { id: uid(n), status: "active", assurance, grants, tokenScopes: [] } satisfies Actor,
});
const adminRole = (role: string): Grant[] => [{ kind: "admin", role } as Grant];
const P = {
  finance: principal(1, "tok-finance-000000001", adminRole("finance")),
  ops: principal(2, "tok-ops-0000000000001", adminRole("ops")),
  security: principal(3, "tok-security-00000001", adminRole("security")),
  marketing: principal(4, "tok-marketing-0000001", adminRole("marketing")),
  dpo: principal(5, "tok-dpo-0000000000001", adminRole("dpo")),
  support: principal(6, "tok-support-000000001", adminRole("support")),
  trust: principal(7, "tok-trust-00000000001", adminRole("trust_safety")),
  superAdmin: principal(8, "tok-super-00000000001", adminRole("super_admin")),
  financeNoPasskey: principal(9, "tok-finance-nopk-000001", adminRole("finance"), "admin_api", "basic"),
  financeExpired: principal(10, "tok-finance-expired-001", [{ kind: "admin", role: "finance", expiresAtMs: 1 }]),
  shopper: principal(11, "tok-shopper-00000000001", [{ kind: "shopper" }], "buyer_api"),
  seller: principal(12, "tok-seller-000000000001", [{ kind: "brand", storeId: uid(900), role: "manager" }], "seller_api"),
  shopperOnAdminAud: principal(13, "tok-shopper-adminaud-01", [{ kind: "shopper" }]),
};

class Auth implements Authenticator {
  private readonly all = new Map(Object.values(P).map((p) => [p.token, p]));
  async authenticate(token: string, nowMs: number) {
    const p = this.all.get(token);
    if (p === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    const claims: AccessClaims = { iss: "test", sub: p.actor.id, aud: p.aud, iat, exp: iat + 600, jti: `j-${p.token}`, sid: `s-${p.token}`, amr: ["otp_sms"] };
    return { actor: p.actor, claims };
  }
}

let app: INestApplication;
let sink: InMemoryAuditSink;
let runs: InMemoryIntegrityRuns;
let enabled = true;
let mode: "batch" | "event" = "batch";

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: "test" });
  const ids = createIdGenerator(clock, nodeCsprng);
  const ledger = new InMemoryLedger();
  runs = new InMemoryIntegrityRuns(clock);
  @Global()
  @Module({})
  class TestAuth {
    static register(): DynamicModule {
      return { module: TestAuth, providers: [{ provide: AUTHENTICATOR, useValue: new Auth() }], exports: [AUTHENTICATOR] };
    }
  }
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuth.register(),
      LedgerModule.forRoot(config, {
        store: ledger as never,
        reads: ledger,
        snapshots: ledger,
        projection: new InMemoryProjection(),
        integrity: { store: runs, reader: runs },
        integrityRoutesEnabled: () => enabled,
        integrityMode: () => mode,
      }),
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  sink = app.get<InMemoryAuditSink>(AUDIT_SINK, { strict: false });
});
afterAll(async () => {
  await app.close();
});

const get = (path: string, who: { token: string } | null) => {
  const r = request(app.getHttpServer()).get(path);
  return who === null ? r : r.set("Authorization", `Bearer ${who.token}`);
};
const ROUTES = ["/v1/admin/ledger/integrity", "/v1/admin/ledger/integrity/runs"];

describe("GET /v1/admin/ledger/integrity authorization matrix", () => {
  for (const path of ROUTES) {
    it(`${path}: shopper and seller 401, wrong audience 401/403, ops/security/marketing/dpo/support/trust_safety 403, standing super_admin 403, no passkey 403, expired grant 403, finance 200`, async () => {
      enabled = true;
      expect((await get(path, null)).status).toBe(401);
      expect((await get(path, P.shopper)).status).toBe(401);
      expect((await get(path, P.seller)).status).toBe(401);
      expect((await get(path, P.shopperOnAdminAud)).status).toBe(403);
      for (const who of [P.ops, P.security, P.marketing, P.dpo, P.support, P.trust, P.superAdmin]) {
        const r = await get(path, who);
        expect(r.status, who.token).toBe(403);
        expect(JSON.stringify(r.body)).not.toContain("latest");
      }
      const nopk = await get(path, P.financeNoPasskey);
      expect(nopk.status).toBe(403);
      expect(nopk.body.code).toBe("passkey_required");
      expect((await get(path, P.financeExpired)).status).toBe(403);
      expect((await get(path, P.finance)).status).toBe(200);
    });
  }

  it("denials are audited with the deny effect and the integrity rule id", async () => {
    await get(ROUTES[0] ?? "", P.ops);
    await get(ROUTES[1] ?? "", P.security);
    expect(sink.entries.some((e) => e.ruleId === "ledger.integrity" && e.effect === "deny" && e.reason === "missing_role")).toBe(true);
    expect(sink.entries.some((e) => e.ruleId === "ledger.integrity_runs" && e.effect === "deny")).toBe(true);
  });

  it("every allowed read is audited before the data is read, and a failing audit sink answers 503 with no report bytes", async () => {
    await recorderFor(runs, clock, { run: async () => okReport() }).recorder.run("nightly");
    const before = sink.entries.length;
    expect((await get(ROUTES[0] ?? "", P.finance)).status).toBe(200);
    expect(sink.entries.length).toBe(before + 1);
    expect(sink.entries.at(-1)).toMatchObject({ ruleId: "ledger.integrity", effect: "allow", actorId: uid(1) });
    const original = sink.record.bind(sink);
    sink.record = async () => Promise.reject(new Error("sink down"));
    try {
      for (const path of ROUTES) {
        const r = await get(path, P.finance);
        expect(r.status).toBe(503);
        expect(r.body.code).toBe("audit_unavailable");
        expect(JSON.stringify(r.body)).not.toContain("report_sha256");
        expect(JSON.stringify(r.body)).not.toContain("chain");
      }
    } finally {
      sink.record = original;
    }
  });

  it("blocked flag: both routes answer 404 for everyone (nothing read, nothing audited)", async () => {
    enabled = false;
    const before = sink.entries.length;
    for (const path of ROUTES) {
      expect((await get(path, P.finance)).status).toBe(404);
      expect((await get(path, P.ops)).status).toBe(404);
    }
    expect(sink.entries.length).toBe(before);
    enabled = true;
  });

  it("there is no write route and no manual-run route", async () => {
    for (const path of ROUTES) {
      const r = await request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${P.finance.token}`).send({});
      expect([404, 405]).toContain(r.status);
    }
  });
});

describe("GET /v1/admin/ledger/integrity contract", () => {
  it("returns the wire shape: strings for bigint amounts, audit_evidence, sample_available, state and cadence", async () => {
    clock.advance(1_000);
    const withDrift = { ...failedReport(), storeCredit: { drift: [driftRow(1, 10n)], negative: [] } };
    await recorderFor(runs, clock, { run: async () => withDrift }).recorder.run("nightly");
    clock.advance(60_000);
    const r = await get(ROUTES[0] ?? "", P.finance);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["as_of", "expected_cadence", "latest", "latest_attempt", "stale", "stale_after", "state"]);
    expect(r.body.state).toBe("failed");
    expect(r.body.expected_cadence).toBe("nightly_0230_cairo");
    expect(r.body.latest.audit_evidence).toBe("present");
    expect(r.body.latest.trial_balance.offenders).toEqual([{ currency: "EGP", total_minor: "-5" }]);
    expect(r.body.latest.chain).toEqual({ ok: false, length: "0", head_hash: null, failure: { seq: "7", entry_id: uid(77), reason: "entry_hash_mismatch" } });
    expect(r.body.latest.store_credit).toMatchObject({ drift_count: 1, sample_truncated: false, sample_available: true });
    expect(r.body.latest.store_credit.sample[0]).toEqual({ account_id: null, sub: "refund_credit", projected_minor: "1000", from_postings_minor: "990", difference_minor: "10" });
    expect(JSON.stringify(r.body)).not.toContain(uid(1));
    expect(JSON.stringify(r.body)).not.toContain("user_id");
    expect(r.body.latest.report_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("failed run then an error attempt: state failed, failed run as latest, error as latest_attempt", async () => {
    clock.advance(60_000);
    await expect(recorderFor(runs, clock, { run: async () => Promise.reject(new Error("x")) }).recorder.run("nightly")).rejects.toThrow();
    const r = await get(ROUTES[0] ?? "", P.finance);
    expect(r.body.state).toBe("failed");
    expect(r.body.latest.ok).toBe(false);
    expect(r.body.latest_attempt).toMatchObject({ outcome: "error", error_code: "job_error" });
  });

  it("event mode uses the 90 minute threshold and the 30-minute cadence label", async () => {
    mode = "event";
    clock.advance(95 * 60_000);
    const r = await get(ROUTES[0] ?? "", P.finance);
    expect(r.body.expected_cadence).toBe("every_30_min");
    expect(r.body.stale).toBe(true);
    mode = "batch";
  });

  it("runs: keyset pagination with an opaque cursor, limit bounds, unknown params and a bad cursor are 400", async () => {
    for (let i = 0; i < 3; i += 1) {
      clock.advance(1_000);
      await recorderFor(runs, clock, { run: async () => okReport() }).recorder.run("intraday");
    }
    const first = await get(`${ROUTES[1]}?limit=2`, P.finance);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.page.has_more).toBe(true);
    const second = await get(`${ROUTES[1]}?limit=2&cursor=${first.body.page.next_cursor}`, P.finance);
    expect(second.status).toBe(200);
    const firstIds = first.body.items.map((i: { id: string }) => i.id);
    for (const i of second.body.items) expect(firstIds).not.toContain(i.id);
    expect((await get(`${ROUTES[1]}?limit=0`, P.finance)).status).toBe(400);
    expect((await get(`${ROUTES[1]}?limit=51`, P.finance)).status).toBe(400);
    expect((await get(`${ROUTES[1]}?bogus=1`, P.finance)).status).toBe(400);
    expect((await get(`${ROUTES[1]}?cursor=not-a-cursor`, P.finance)).status).toBe(400);
  });

  it("a reader outage is 503 integrity_unavailable, never a stack trace", async () => {
    const original = runs.snapshot.bind(runs);
    runs.snapshot = async () => Promise.reject(new Error("db password=hunter2"));
    try {
      const r = await get(ROUTES[0] ?? "", P.finance);
      expect(r.status).toBe(503);
      expect(r.body.code).toBe("integrity_unavailable");
      expect(JSON.stringify(r.body)).not.toContain("hunter2");
    } finally {
      runs.snapshot = original;
    }
  });
});
