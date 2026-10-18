import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, Grant } from "@outlet/policy";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUDIT_SINK, AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator, type InMemoryAuditSink } from "../../../platform";
import { InMemoryAdminAudit, InMemoryAdminStore } from "../../admin";
import { AdminAttentionModule } from "../admin-attention.module";
import { InMemoryAttentionSources, InMemoryAuditChains } from "../adapters/in-memory";
import { ATTENTION_ITEMS, CAPABILITY_ROLES, capabilityPredicates, visibleAttentionItems } from "../domain/attention";

class Clock {
  constructor(private ms: number) {}
  advance(d: number): void {
    this.ms += d;
  }
  nowMs(): number {
    return this.ms;
  }
}
const clock = new Clock(Date.UTC(2026, 9, 29, 6, 0));
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Aud = AccessClaims["aud"];
const principal = (n: number, grants: Grant[], aud: Aud = "admin_api", assurance: Actor["assurance"] = "passkey") => ({
  token: `tok-${n}-0000000000000000`,
  aud,
  actor: { id: uid(n), status: "active", assurance, grants, tokenScopes: [] } satisfies Actor,
});
const role = (r: string): Grant[] => [{ kind: "admin", role: r } as Grant];
const ROLES = ["finance", "ops", "security", "marketing", "dpo", "support", "trust_safety"] as const;
const P = {
  ...Object.fromEntries(ROLES.map((r, i) => [r, principal(i + 1, role(r))])),
  superAdmin: principal(20, role("super_admin")),
  breakGlass: principal(21, role("super_admin")),
  dpoNoPasskey: principal(22, role("dpo"), "admin_api", "basic"),
  dpoExpired: principal(23, [{ kind: "admin", role: "dpo", expiresAtMs: 1 }]),
  shopper: principal(30, [{ kind: "shopper" }], "buyer_api"),
  seller: principal(31, [{ kind: "brand", storeId: uid(900), role: "manager" }], "seller_api"),
  shopperOnAdminAud: principal(32, [{ kind: "shopper" }]),
} as Record<string, ReturnType<typeof principal>>;

class Auth implements Authenticator {
  async authenticate(token: string, nowMs: number) {
    const p = Object.values(P).find((x) => x.token === token);
    if (p === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    return { actor: p.actor, claims: { iss: "test", sub: p.actor.id, aud: p.aud, iat, exp: iat + 600, jti: `j-${token}`, sid: `s-${token}`, amr: ["otp_sms"] } as AccessClaims };
  }
}

let app: INestApplication;
let sink: InMemoryAuditSink;
let chains: InMemoryAuditChains;
let sources: InMemoryAttentionSources;
let metaAudit: InMemoryAdminAudit;
let store: InMemoryAdminStore;
let auditOn = true;
let attentionOn = true;

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: "test" });
  const ids = createIdGenerator(clock, nodeCsprng);
  chains = new InMemoryAuditChains();
  sources = new InMemoryAttentionSources();
  metaAudit = new InMemoryAdminAudit();
  store = new InMemoryAdminStore();
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
      AdminAttentionModule.forRoot(config, {
        chains, sources, elevations: store, audit: metaAudit,
        auditLogRoutesEnabled: () => auditOn,
        attentionRoutesEnabled: () => attentionOn,
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
beforeEach(() => {
  auditOn = true;
  attentionOn = true;
  chains.failReads = false;
  sources.readings.clear();
  sources.hang.clear();
  sources.calls.length = 0;
  metaAudit.entries.length = 0;
});

const get = (path: string, who: { token: string } | null) => {
  clock.advance(61_000); // fresh rate-limit window per call; the limiter is tested by its own suite
  const r = request(app.getHttpServer()).get(path);
  return who === null ? r : r.set("Authorization", `Bearer ${who.token}`);
};
const V = "/v1/admin/audit-log/verify?chain_id=admin:2026-10";
const A = "/v1/admin/attention";

describe("GET /v1/admin/audit-log/verify", () => {
  it("authorization matrix: 401 shopper/seller/anon, wrong audience 403, non-audit roles 403, standing super_admin 403, no passkey 403, expired 403, dpo/security 200", async () => {
    chains.append("admin:2026-10", "a");
    expect((await get(V, null)).status).toBe(401);
    expect((await get(V, P.shopper!)).status).toBe(401);
    expect((await get(V, P.seller!)).status).toBe(401);
    expect((await get(V, P.shopperOnAdminAud!)).status).toBe(403);
    for (const r of ["finance", "ops", "marketing", "support", "trust_safety"]) expect((await get(V, P[r]!)).status, r).toBe(403);
    expect((await get(V, P.superAdmin!)).status).toBe(403);
    const nopk = await get(V, P.dpoNoPasskey!);
    expect(nopk.status).toBe(403);
    expect(nopk.body.code).toBe("passkey_required");
    expect((await get(V, P.dpoExpired!)).status).toBe(403);
    expect((await get(V, P.dpo!)).status).toBe(200);
    expect((await get(V, P.security!)).status).toBe(200);
  });
  it("blocked flag answers 404 and audits nothing; missing/odd chain_id is 400", async () => {
    auditOn = false;
    expect((await get(V, P.dpo!)).status).toBe(404);
    expect(metaAudit.entries).toHaveLength(0);
    auditOn = true;
    expect((await get("/v1/admin/audit-log/verify", P.dpo!)).status).toBe(400);
    expect((await get("/v1/admin/audit-log/verify?chain_id=a%20b", P.dpo!)).status).toBe(400);
    expect((await get(`${V}&x=1`, P.dpo!)).status).toBe(400);
  });
  it("reports ok on a clean chain and the tamper/gap on a damaged one; response has only contract fields", async () => {
    chains.append("c1", "a");
    chains.append("c1", "b");
    chains.checkpoint("c1");
    const ok = await get("/v1/admin/audit-log/verify?chain_id=c1", P.dpo!);
    expect(ok.body).toMatchObject({ chain_id: "c1", rows_checked: 2, head_seq: "2", checkpoints_checked: 1, ok: true, problems: [], problems_truncated: false });
    expect(Object.keys(ok.body).sort()).toEqual(["chain_id", "checkpoints_checked", "head_hash", "head_seq", "ok", "problems", "problems_truncated", "rows_checked", "verified_at"]);
    chains.tamperRow("c1", 1, "evil");
    const bad = await get("/v1/admin/audit-log/verify?chain_id=c1", P.security!);
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.problems[0].seq).toBe("1");
  });
  it("writes the meta-audit before the body; its failure gives 503 and no body", async () => {
    await get(V, P.dpo!);
    expect(metaAudit.entries.at(-1)).toMatchObject({ action: "audit_log.verify", actorId: P.dpo!.actor.id, diff: { chain_id: "admin:2026-10" } });
    metaAudit.failNext = true;
    const r = await get(V, P.dpo!);
    expect(r.status).toBe(503);
    expect(r.body.rows_checked).toBeUndefined();
  });
  it("denials are audited with deny; a reader failure is 503", async () => {
    await get(V, P.finance!);
    expect(sink.entries.some((e) => e.effect === "deny" && e.ruleId === "admin_attention.audit_verify")).toBe(true);
    chains.failReads = true;
    expect((await get(V, P.dpo!)).status).toBe(503);
  });
  it("truncates problems to 100 and flags it", async () => {
    for (let i = 0; i < 130; i++) chains.append("big", `r${i}`);
    for (let i = 1; i <= 130; i++) chains.tamperRow("big", i, "x");
    const r = await get("/v1/admin/audit-log/verify?chain_id=big", P.dpo!);
    expect(r.body.problems).toHaveLength(100);
    expect(r.body.problems_truncated).toBe(true);
  });
  it("a chain over 200,000 rows answers 422 chain_too_long_use_job", async () => {
    const orig = chains.chainLength.bind(chains);
    chains.chainLength = async () => 200_001;
    const r = await get(V, P.dpo!);
    chains.chainLength = orig;
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("chain_too_long_use_job");
  });
});

describe("GET /v1/admin/attention", () => {
  const ids = (b: { items: { id: string }[] }) => b.items.map((i) => i.id).sort();
  const seedAll = () => ATTENTION_ITEMS.forEach((i) => sources.readings.set(i.id, { count: 3, oldestAtMs: 1_000, deadlineAtMs: null }));

  it("401/403 matrix and blocked flag", async () => {
    expect((await get(A, null)).status).toBe(401);
    expect((await get(A, P.shopper!)).status).toBe(401);
    expect((await get(A, P.seller!)).status).toBe(401);
    expect((await get(A, P.shopperOnAdminAud!)).status).toBe(403);
    expect((await get(A, P.superAdmin!)).status).toBe(403);
    expect((await get(A, P.dpoNoPasskey!)).status).toBe(403);
    attentionOn = false;
    expect((await get(A, P.finance!)).status).toBe(404);
  });
  it("role leakage matrix equals the predicate-derived item set, and spec examples hold", async () => {
    seedAll();
    for (const r of ROLES) {
      const body = (await get(A, P[r]!)).body;
      const access = { actorId: "x", standing: [r], effective: [r], breakGlassLive: false, passkey: true } as never;
      expect(ids(body), r).toEqual(visibleAttentionItems(access).map((i) => i.id).sort());
    }
    const idsOf = async (r: string) => ids((await get(A, P[r]!)).body);
    expect((await idsOf("finance")).some((i) => i.startsWith("privacy."))).toBe(false);
    expect(await idsOf("marketing")).toEqual(["approvals.waiting_on_me", "elevations.expiring"]);
    const ops = await idsOf("ops");
    expect(ops).toContain("recon.tickets_aged");
    expect(ops).toContain("tax.rejected");
    expect(ops).not.toContain("ledger.integrity");
    expect(await idsOf("support")).not.toContain("brand_applications.sla_late");
    expect(await idsOf("marketing")).not.toContain("payouts.on_hold_or_failed");
  });
  it("every item capability is a key of the capability map (deny by default)", () => {
    for (const i of ATTENTION_ITEMS) expect(Object.keys(CAPABILITY_ROLES)).toContain(i.capability);
    expect(Object.keys(capabilityPredicates).sort()).toEqual(Object.keys(CAPABILITY_ROLES).sort());
  });
  it("omitted items never appear as zero; sources for hidden items are never called", async () => {
    seedAll();
    await get(A, P.marketing!);
    expect(sources.calls.map((c) => c.itemId).sort()).toEqual(["approvals.waiting_on_me", "elevations.expiring"]);
  });
  it("caps counts at 1000, a failing source is unavailable with null count (never 0), no-store header, no PII keys", async () => {
    sources.readings.set("approvals.waiting_on_me", { count: 5000, oldestAtMs: null, deadlineAtMs: 5_000 });
    const r = await get(A, P.marketing!);
    expect(r.headers["cache-control"]).toContain("no-store");
    const ok = r.body.items.find((i: { id: string }) => i.id === "approvals.waiting_on_me");
    expect(ok).toMatchObject({ count: 1000, count_capped: true, state: "ok" });
    const bad = r.body.items.find((i: { id: string }) => i.id === "elevations.expiring");
    expect(bad).toMatchObject({ count: null, state: "unavailable" });
    expect(Object.keys(ok).sort()).toEqual(["count", "count_capped", "deadline_at", "group", "href", "id", "oldest_at", "severity", "state"]);
  });
  it("a hanging source times out to unavailable within ~2 s", async () => {
    seedAll();
    sources.hang.add("elevations.expiring");
    const t = Date.now();
    const r = await get(A, P.marketing!);
    expect(Date.now() - t).toBeLessThan(4000);
    expect(r.body.items.find((i: { id: string }) => i.id === "elevations.expiring").state).toBe("unavailable");
  }, 10_000);
});
