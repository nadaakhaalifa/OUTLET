import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultRules } from "@outlet/policy";
import { EDGE_POSTURE_MAX_SKEW_MS, EDGE_POSTURE_REPLAY_TTL_S, InMemoryEdgeReplayStore, signEdgePosture, verifyEdgePosture } from "./adapters/edge-posture";
import { InMemoryAdminAudit, InMemoryAdminStore, InMemoryFlagBackend, InMemoryPiiSource, InMemorySellerKyc } from "./adapters/in-memory";
import { buildAdminMe, computeCapabilities } from "./application/me";
import { computeAccess } from "./domain/access";
import { ADMIN_ROLE_NAMES, type AdminRoleName } from "./domain/bridge";
import { CAPABILITY_KEYS, assuranceFromAmr } from "./domain/me";
import { AdminIdentityConfigError, AdminModule } from "./admin.module";
import { idemKey, START_MS, uid } from "./test/harness";
import { adminSubject, bearerOf, createMeHarness, role, seedElevation, type MeHarness } from "./test/me-harness";
import { loadConfig } from "../../config/env";

let h: MeHarness;
afterEach(async () => {
  await h.close();
});

const KEY = new Uint8Array(32).fill(7);
const keys = new Map<string, Uint8Array>([["k1", KEY]]);

describe("GET /v1/admin/me", () => {
  it("answers 404 while release.admin_console.identity is blocked (default)", async () => {
    h = await createMeHarness({ enabled: () => false });
    const s = h.add(adminSubject(1, [role("ops")]));
    const r = await h.http().get("/v1/admin/me").set(bearerOf(s));
    expect(r.status).toBe(404);
  });

  it("authentication: no token, unknown token, buyer and seller audiences are 401", async () => {
    h = await createMeHarness();
    const buyer = h.add(adminSubject(2, [role("ops")], { aud: "buyer_api" }));
    const seller = h.add(adminSubject(3, [role("ops")], { aud: "seller_api" }));
    expect((await h.http().get("/v1/admin/me")).status).toBe(401);
    expect((await h.http().get("/v1/admin/me").set({ Authorization: "Bearer nope-nope-nope-nope-nope" })).status).toBe(401);
    expect((await h.http().get("/v1/admin/me").set(bearerOf(buyer))).status).toBe(401);
    expect((await h.http().get("/v1/admin/me").set(bearerOf(seller))).status).toBe(401);
    expect(h.counts).toEqual([]);
  });

  it("admin audience without an admin grant is 403 not_admin, audited once, counted as deny", async () => {
    h = await createMeHarness();
    const s = h.add(adminSubject(4, [{ kind: "shopper" }]));
    const r = await h.http().get("/v1/admin/me").set(bearerOf(s));
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toContain("not_admin");
    const rows = h.sink.entries.filter((e) => e.ruleId === "admin.me");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.effect).toBe("deny");
    expect(h.counts).toEqual(["deny"]);
  });

  it("an expired standing grant is excluded (403 not_admin)", async () => {
    h = await createMeHarness();
    const s = h.add(adminSubject(5, [role("ops", START_MS)]));
    expect((await h.http().get("/v1/admin/me").set(bearerOf(s))).status).toBe(403);
    const s2 = h.add(adminSubject(6, [role("ops", START_MS + 1)]));
    expect((await h.http().get("/v1/admin/me").set(bearerOf(s2))).status).toBe(200);
  });

  it("allowed read: document, no-store, no audit row, counted as allow; client hints and Phase A posture", async () => {
    h = await createMeHarness();
    const s = h.add(adminSubject(7, [role("ops")]));
    const r = await h.http().get("/v1/admin/me").set(bearerOf(s)).set("X-Admin-Roles", "super_admin,finance").set("X-Admin-Install", "whatever");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body.version).toBe(1);
    expect(r.body.user_id).toBe(s.actor.id);
    expect(r.body.roles).toEqual(["ops"]);
    expect(r.body.standing_roles).toEqual(["ops"]);
    expect(r.body.assurance).toBe("passkey");
    expect(r.body.posture).toEqual({
      ip_allowlisted: false,
      device_trusted: false,
      ip_allowlist_source: "not_configured",
      device_source: "not_configured",
      session_binding: "passkey_uv_unbound",
    });
    expect(Object.keys(r.body.capabilities).sort()).toEqual([...CAPABILITY_KEYS].sort());
    expect(r.body.capabilities["flags.write"]).toBe(true);
    expect(r.body.capabilities["metrics.read.counts"]).toBe(true);
    expect(r.body.capabilities["metrics.read.money"]).toBe(false);
    expect(r.body.capabilities["ledger.read"]).toBe(false);
    expect(h.sink.entries.filter((e) => e.ruleId === "admin.me")).toHaveLength(0);
    expect(h.counts).toEqual(["allow"]);
    expect(new Date(r.body.session_expires_at).getTime()).toBeGreaterThan(new Date(r.body.server_time).getTime());
  });

  it("any query parameter is 400", async () => {
    h = await createMeHarness();
    const s = h.add(adminSubject(8, [role("ops")]));
    expect((await h.http().get("/v1/admin/me?roles=finance").set(bearerOf(s))).status).toBe(400);
    expect((await h.http().get("/v1/admin/me?x=").set(bearerOf(s))).status).toBe(400);
  });

  it("a session without a passkey gets no gated capability and assurance otp", async () => {
    h = await createMeHarness();
    const s = h.add(adminSubject(9, [role("finance")], { amr: ["otp_sms"], assurance: "basic" }));
    const r = await h.http().get("/v1/admin/me").set(bearerOf(s));
    expect(r.status).toBe(200);
    expect(r.body.assurance).toBe("otp");
    expect(r.body.posture.session_binding).toBe("not_passkey");
    for (const k of CAPABILITY_KEYS) expect(r.body.capabilities[k], k).toBe(false);
  });

  it("elevations: present at expires_at - 1 ms, absent at expires_at; standing super_admin alone grants no route roles", async () => {
    h = await createMeHarness();
    const s = h.add(adminSubject(10, [role("support")]));
    expect((await h.http().get("/v1/admin/me").set(bearerOf(s))).body.capabilities["flags.write"]).toBe(false);
    const exp = START_MS + 60_000;
    await seedElevation(h.store, s.actor.id, "ops", exp);
    h.clock.advance(59_999);
    let r = await h.http().get("/v1/admin/me").set(bearerOf(s));
    expect(r.body.roles).toEqual(["ops", "support"]);
    expect(r.body.standing_roles).toEqual(["support"]);
    expect(r.body.elevation.live).toHaveLength(1);
    expect(r.body.elevation.next_expiry_at).toBe(new Date(exp).toISOString());
    expect(r.body.capabilities["flags.write"]).toBe(true);
    h.clock.advance(1);
    r = await h.http().get("/v1/admin/me").set(bearerOf(s));
    expect(r.body.roles).toEqual(["support"]);
    expect(r.body.elevation.live).toEqual([]);
    expect(r.body.elevation.next_expiry_at).toBeNull();
    expect(r.body.capabilities["flags.write"]).toBe(false);
  });

  it("standing super_admin without break-glass: not in roles, only the tax gate (ADR-0049 item 9) opens; break-glass for a non-standing user is ignored", async () => {
    h = await createMeHarness();
    const sa = h.add(adminSubject(11, [role("super_admin")]));
    let r = await h.http().get("/v1/admin/me").set(bearerOf(sa));
    expect(r.body.roles).toEqual([]);
    expect(r.body.standing_roles).toEqual(["super_admin"]);
    const on = Object.entries(r.body.capabilities as Record<string, boolean>).filter(([, v]) => v).map(([k]) => k);
    expect(on).toEqual(["tax.read"]);
    await seedElevation(h.store, sa.actor.id, "super_admin", START_MS + 600_000, 2);
    r = await h.http().get("/v1/admin/me").set(bearerOf(sa));
    expect(r.body.elevation.break_glass_live).toBe(true);
    expect(r.body.roles).toEqual(["super_admin"]);
    expect(r.body.capabilities["audit_log.read"]).toBe(true);
    const ops = h.add(adminSubject(12, [role("ops")]));
    await seedElevation(h.store, ops.actor.id, "super_admin", START_MS + 600_000, 3);
    r = await h.http().get("/v1/admin/me").set(bearerOf(ops));
    expect(r.body.roles).toEqual(["ops"]);
    expect(r.body.elevation.break_glass_live).toBe(false);
    expect(r.body.elevation.live).toEqual([]);
  });

  it("elevations store unavailable is 503 elevations_unavailable and counted", async () => {
    h = await createMeHarness();
    const s = h.add(adminSubject(13, [role("ops")]));
    h.store.liveElevations = () => Promise.reject(new Error("db down"));
    const r = await h.http().get("/v1/admin/me").set(bearerOf(s));
    expect(r.status).toBe(503);
    expect(h.counts).toEqual(["unavailable"]);
  });

  it("rate limit: the 121st request in a minute is 429", async () => {
    h = await createMeHarness();
    const s = h.add(adminSubject(14, [role("ops")]));
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await h.http().get("/v1/admin/me").set(bearerOf(s))).status;
    expect(last).toBe(429);
  });
});

describe("edge posture header", () => {
  const withHeader = async (mk: (rid: string, now: number) => string | undefined, subj = 20) => {
    h = await createMeHarness({ edgeKeys: keys });
    const s = h.add(adminSubject(subj, [role("finance")]));
    const rid = "0192f3a4-5b6c-7d8e-9f01-aaaaaaaaaaaa";
    const hdr = mk(rid, START_MS);
    const req = h.http().get("/v1/admin/me").set(bearerOf(s)).set("X-Request-Id", rid);
    const r = await (hdr === undefined ? req : req.set("X-Outlet-Edge-Posture", hdr));
    return { r, rid, s };
  };
  const sign = (o: Partial<{ kid: string; ip: boolean; ts: number; rid: string }>) => (rid: string, now: number) =>
    signEdgePosture(KEY, { kid: o.kid ?? "k1", ip_allowlisted: o.ip ?? true, ts: o.ts ?? now, request_id: o.rid ?? rid });

  it("valid header attests the allow-list", async () => {
    const { r } = await withHeader(sign({}));
    expect(r.body.posture.ip_allowlisted).toBe(true);
    expect(r.body.posture.ip_allowlist_source).toBe("edge_attested");
    expect(r.body.posture.device_trusted).toBe(false);
  });
  it("valid header can attest 'not on the allow-list'", async () => {
    const { r } = await withHeader(sign({ ip: false }));
    expect(r.body.posture.ip_allowlisted).toBe(false);
    expect(r.body.posture.ip_allowlist_source).toBe("edge_attested");
  });
  it("missing header: not_configured", async () => {
    const { r } = await withHeader(() => undefined);
    expect(r.body.posture.ip_allowlist_source).toBe("not_configured");
    expect(r.body.posture.ip_allowlisted).toBe(false);
  });
  it.each([
    ["bad mac", (rid: string, now: number) => sign({})(rid, now).replace(/.$/, (c) => (c === "A" ? "B" : "A"))],
    ["unknown kid", sign({ kid: "k9" })],
    ["stale ts", sign({ ts: START_MS - 60_001 })],
    ["future ts", sign({ ts: START_MS + 60_001 })],
    ["wrong request id", sign({ rid: "0192f3a4-5b6c-7d8e-9f01-bbbbbbbbbbbb" })],
    ["unsigned garbage", () => "v1.k1.e30.AAAA"],
    ["short mac (length mismatch)", (rid: string, now: number) => sign({})(rid, now).split(".").slice(0, 3).join(".") + ".AAAA"],
    ["wrong version", (rid: string, now: number) => sign({})(rid, now).replace("v1.", "v2.")],
  ])("%s gives ip_allowlisted false / invalid", async (_n, mk) => {
    const { r } = await withHeader(mk);
    expect(r.status).toBe(200);
    expect(r.body.posture.ip_allowlisted).toBe(false);
    expect(r.body.posture.ip_allowlist_source).toBe("invalid");
  });
  it("a replayed header is invalid the second time", async () => {
    h = await createMeHarness({ edgeKeys: keys });
    const s = h.add(adminSubject(21, [role("finance")]));
    const rid = "0192f3a4-5b6c-7d8e-9f01-cccccccccccc";
    const hdr = signEdgePosture(KEY, { kid: "k1", ip_allowlisted: true, ts: START_MS, request_id: rid });
    const go = () => h.http().get("/v1/admin/me").set(bearerOf(s)).set("X-Request-Id", rid).set("X-Outlet-Edge-Posture", hdr);
    expect((await go()).body.posture.ip_allowlist_source).toBe("edge_attested");
    expect((await go()).body.posture.ip_allowlist_source).toBe("invalid");
  });
  it("replay store unavailable fails closed", async () => {
    h = await createMeHarness({ edgeKeys: keys, replay: { claim: () => Promise.reject(new Error("redis down")) } });
    const s = h.add(adminSubject(22, [role("finance")]));
    const rid = "0192f3a4-5b6c-7d8e-9f01-dddddddddddd";
    const hdr = signEdgePosture(KEY, { kid: "k1", ip_allowlisted: true, ts: START_MS, request_id: rid });
    const r = await h.http().get("/v1/admin/me").set(bearerOf(s)).set("X-Request-Id", rid).set("X-Outlet-Edge-Posture", hdr);
    expect(r.body.posture.ip_allowlisted).toBe(false);
  });
  it("default (no replay store configured) never attests", async () => {
    h = await createMeHarness({ edgeKeys: keys, replay: undefined as never });
    const s = h.add(adminSubject(23, [role("finance")]));
    const rid = "0192f3a4-5b6c-7d8e-9f01-eeeeeeeeeeee";
    const hdr = signEdgePosture(KEY, { kid: "k1", ip_allowlisted: true, ts: START_MS, request_id: rid });
    const r = await h.http().get("/v1/admin/me").set(bearerOf(s)).set("X-Request-Id", rid).set("X-Outlet-Edge-Posture", hdr);
    expect(r.body.posture.ip_allowlisted).toBe(false);
  });
  it("dev trust sets both signals with dev_override outside production", async () => {
    h = await createMeHarness({ devTrust: true });
    const s = h.add(adminSubject(24, [role("finance")]));
    const r = await h.http().get("/v1/admin/me").set(bearerOf(s));
    expect(r.body.posture).toMatchObject({ ip_allowlisted: true, device_trusted: true, ip_allowlist_source: "dev_override", device_source: "dev_override" });
  });
  it("session binding comes from the port, never from the client header alone", async () => {
    h = await createMeHarness({ binding: { bindingOf: async (i) => (i.installToken === "good" ? "passkey_uv_browser_bound" : "passkey_uv_unbound") } });
    const s = h.add(adminSubject(25, [role("ops")]));
    const good = await h.http().get("/v1/admin/me").set(bearerOf(s)).set("X-Admin-Install", "good");
    const bad = await h.http().get("/v1/admin/me").set(bearerOf(s)).set("X-Admin-Install", "bad");
    expect(good.body.posture.session_binding).toBe("passkey_uv_browser_bound");
    expect(bad.body.posture.session_binding).toBe("passkey_uv_unbound");
    expect(good.body.posture.device_trusted).toBe(false);
  });
});

describe("boot checks", () => {
  const prod = loadConfig({ NODE_ENV: "test" });
  // "Real adapters" is the criterion, not NODE_ENV.
  const real = { ...prod, adapters: "production" as const };
  const stores = {
    store: new InMemoryAdminStore(),
    audit: new InMemoryAdminAudit(),
    kyc: new InMemorySellerKyc(),
    flags: new InMemoryFlagBackend([]),
    pii: new InMemoryPiiSource(),
  };
  it("refuses ADMIN_POSTURE_DEV_TRUST with real adapters even outside NODE_ENV=production", () => {
    expect(real.env).not.toBe("production");
    expect(() => AdminModule.forRoot(real, { ...stores, identity: { devTrust: true } })).toThrow(AdminIdentityConfigError);
  });
  it("refuses posture keys without the private-ingress attestation with real adapters", () => {
    expect(() => AdminModule.forRoot(real, { ...stores, identity: { edgeKeys: keys } })).toThrow(AdminIdentityConfigError);
    expect(() => AdminModule.forRoot(real, { ...stores, identity: { edgeKeys: keys, privateIngressAttested: true } })).not.toThrow();
  });
  it("refuses more than two active kids", () => {
    const three = new Map([["a", KEY], ["b", KEY], ["c", KEY]]);
    expect(() => AdminModule.forRoot(prod, { identity: { edgeKeys: three } })).toThrow(AdminIdentityConfigError);
  });
  it("refuses an edge posture key shorter than 32 bytes", () => {
    const short = new Map([["k1", new Uint8Array(31).fill(1)]]);
    expect(() => AdminModule.forRoot(prod, { identity: { edgeKeys: short } })).toThrow(AdminIdentityConfigError);
    expect(() => AdminModule.forRoot(prod, { identity: { edgeKeys: new Map([["k1", new Uint8Array(32).fill(1)]]) } })).not.toThrow();
  });
});

describe("hardening (wave 2 review)", () => {
  const RID = "0192f3a4-5b6c-7d8e-9f01-ffffffffffff";
  it("two concurrent replay claims: exactly one wins", async () => {
    const r = new InMemoryEdgeReplayStore();
    const res = await Promise.all([r.claim("k1", RID), r.claim("k1", RID)]);
    expect(res.filter(Boolean)).toHaveLength(1);
    const hdr = signEdgePosture(KEY, { kid: "k1", ip_allowlisted: true, ts: START_MS, request_id: "rid-concurrent" });
    const out = await Promise.all([1, 2].map(() => verifyEdgePosture({ header: hdr, keys, requestId: "rid-concurrent", nowMs: START_MS, replay: r })));
    expect(out.filter((o) => o.source === "edge_attested")).toHaveLength(1);
  });
  it("replay TTL is above twice the skew; ts boundary at +/-60s is accepted, +60.001s is not", async () => {
    expect(EDGE_POSTURE_REPLAY_TTL_S * 1000).toBeGreaterThan(2 * EDGE_POSTURE_MAX_SKEW_MS);
    const at = (ts: number) =>
      verifyEdgePosture({ header: signEdgePosture(KEY, { kid: "k1", ip_allowlisted: true, ts, request_id: "r" + ts }), keys, requestId: "r" + ts, nowMs: START_MS, replay: new InMemoryEdgeReplayStore() });
    expect((await at(START_MS - 60_000)).source).toBe("edge_attested");
    expect((await at(START_MS - 120_000)).source).toBe("invalid");
    expect((await at(START_MS - 60_001)).source).toBe("invalid");
  });
  it("the replay claim uses the 180 s TTL", async () => {
    const ttls: number[] = [];
    await verifyEdgePosture({ header: signEdgePosture(KEY, { kid: "k1", ip_allowlisted: true, ts: START_MS, request_id: "t" }), keys, requestId: "t", nowMs: START_MS, replay: { claim: (_k, _r, ttl) => (ttls.push(ttl), Promise.resolve(true)) } });
    expect(ttls).toEqual([180]);
  });
  it("a non-admin admin_api token gets 403 (not 503) while the elevation store is down", async () => {
    h = await createMeHarness();
    const s = h.add(adminSubject(40, [{ kind: "shopper" }]));
    h.store.liveElevations = () => Promise.reject(new Error("db down"));
    const r = await h.http().get("/v1/admin/me").set(bearerOf(s));
    expect(r.status).toBe(403);
    expect(h.counts).toEqual(["deny"]);
  });
  it("actor.assurance and amr disagreeing is refused", async () => {
    h = await createMeHarness();
    const a = h.add(adminSubject(41, [role("ops")], { assurance: "passkey", amr: ["otp"] }));
    const b = h.add(adminSubject(42, [role("ops")], { assurance: "basic", amr: ["passkey"] }));
    expect((await h.http().get("/v1/admin/me").set(bearerOf(a))).status).toBe(403);
    expect((await h.http().get("/v1/admin/me").set(bearerOf(b))).status).toBe(403);
  });
  it("assurance shown comes from actor.assurance", () => {
    const actor = adminSubject(43, [role("ops")], { assurance: "basic", amr: ["totp"] }).actor;
    const doc = buildAdminMe({ actor, access: computeAccess(actor, [], START_MS), elevations: [], amr: ["totp"], sessionExpiresAtMs: START_MS + 1, rules: createDefaultRules({ refundDualApprovalAtOrAboveMinor: 1n, payoutDualApprovalAtOrAboveMinor: 1n } as never), nowMs: START_MS, ip: { allowlisted: false, source: "not_configured" }, binding: "not_passkey", devTrust: false });
    expect(doc.assurance).toBe("totp");
  });
  it("duplicate X-Outlet-Edge-Posture headers never attest", async () => {
    h = await createMeHarness({ edgeKeys: keys });
    const s = h.add(adminSubject(44, [role("finance")]));
    const hdr = signEdgePosture(KEY, { kid: "k1", ip_allowlisted: true, ts: START_MS, request_id: RID });
    const r = await h.http().get("/v1/admin/me").set(bearerOf(s)).set("X-Request-Id", RID).set("X-Outlet-Edge-Posture", [hdr, hdr] as unknown as string);
    expect(r.body.posture.ip_allowlisted).toBe(false);
    expect(r.body.posture.ip_allowlist_source).toBe("invalid");
  });
  it("duplicate X-Admin-Install headers are not passed to the binding port", async () => {
    const seen: (string | undefined)[] = [];
    h = await createMeHarness({ binding: { bindingOf: async (i) => (seen.push(i.installToken), "passkey_uv_unbound") } });
    const s = h.add(adminSubject(45, [role("ops")]));
    await h.http().get("/v1/admin/me").set(bearerOf(s)).set("X-Admin-Install", ["a", "b"] as unknown as string);
    await h.http().get("/v1/admin/me").set(bearerOf(s)).set("X-Admin-Install", "a,b");
    expect(seen).toEqual([undefined, undefined]);
  });
  it("a hanging session-binding port times out to the unbound default", async () => {
    h = await createMeHarness({ binding: { bindingOf: () => new Promise(() => undefined) } });
    const s = h.add(adminSubject(46, [role("ops")]));
    const r = await h.http().get("/v1/admin/me").set(bearerOf(s));
    expect(r.status).toBe(200);
    expect(r.body.posture.session_binding).toBe("passkey_uv_unbound");
  }, 10_000);
});

describe("capability equality with the mirrored admin routes (HTTP level)", () => {
  const rules = createDefaultRules({ refundDualApprovalAtOrAboveMinor: 1n, payoutDualApprovalAtOrAboveMinor: 1n } as never);
  const KYC_ID = uid(777);
  /** Committed route table: capability -> a request the gate (not a pipe) decides. A new admin_api route needs a row. */
  const table: readonly { cap: (typeof CAPABILITY_KEYS)[number]; call: (h: MeHarness, s: ReturnType<typeof adminSubject>) => Promise<number> }[] = [
    { cap: "flags.read", call: async (hh, s) => (await hh.http().get("/v1/admin/flags").set(bearerOf(s))).status },
    {
      cap: "flags.write",
      call: async (hh, s) =>
        (await hh.http().put("/v1/admin/flags/kill.drops").set(bearerOf(s)).set("Idempotency-Key", idemKey()).send({ enabled: true, reason_code: "incident_response" })).status,
    },
    { cap: "kyc.read", call: async (hh, s) => (await hh.http().get("/v1/admin/kyc/queue").set(bearerOf(s))).status },
    {
      cap: "kyc.write",
      call: async (hh, s) =>
        (await hh.http().post(`/v1/admin/kyc/sellers/${KYC_ID}/suspend`).set(bearerOf(s)).set("Idempotency-Key", idemKey()).send({ reason_code: "fraud_investigation" })).status,
    },
    { cap: "kyc_review.read", call: async (hh, s) => (await hh.http().get("/v1/admin/kyc/suspension-reviews").set(bearerOf(s))).status },
    { cap: "elevations.admin", call: async (hh, s) => (await hh.http().get("/v1/admin/elevations").set(bearerOf(s))).status },
    {
      cap: "pii.view",
      call: async (hh, s) =>
        (await hh.http().post("/v1/admin/pii-views").set(bearerOf(s)).set("Idempotency-Key", idemKey()).send({ subject_user_id: uid(888), fields: ["email"], reason_code: "customer_support_ticket" })).status,
    },
  ];

  it("for random actors, capabilities[k] is true iff the mirrored route is not 403", async () => {
    h = await createMeHarness();
    let n = 100;
    await fc.assert(
      fc.asyncProperty(
        fc.subarray([...ADMIN_ROLE_NAMES], { minLength: 1 }),
        fc.option(fc.constantFrom(...ADMIN_ROLE_NAMES), { nil: undefined }),
        fc.boolean(),
        async (standing, elev, passkey) => {
          n += 1;
          const s = h.add(adminSubject(n, standing.map((r) => role(r)), passkey ? {} : { amr: ["otp_sms"], assurance: "basic" }));
          if (elev !== undefined) await seedElevation(h.store, s.actor.id, elev, START_MS + 3_600_000, n);
          const me = await h.http().get("/v1/admin/me").set(bearerOf(s));
          expect(me.status).toBe(200);
          for (const row of table) {
            const status = await row.call(h, s);
            expect(me.body.capabilities[row.cap], `${row.cap} for ${standing.join(",")}+${String(elev)} passkey=${String(passkey)} -> ${String(status)}`).toBe(status !== 403);
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it("pure properties: roles are standing (minus super_admin) plus live elevations; assurance follows amr; no capability beyond console without an effective role", () => {
    fc.assert(
      fc.property(fc.subarray([...ADMIN_ROLE_NAMES]), fc.subarray([...ADMIN_ROLE_NAMES]), fc.subarray(["otp_sms", "passkey", "webauthn", "totp", "apple"] as const), (standing, extra, amr) => {
        const actor = adminSubject(1, standing.map((r) => role(r))).actor;
        const elevations = extra.map((r, i) => ({
          id: uid(900 + i), userId: actor.id, role: r as AdminRoleName, reasonCode: "x", approvalId: uid(i), requestedTtlMs: 1, state: "ACTIVE" as const,
          requestedAtMs: 0, activatedAtMs: 0, expiresAtMs: START_MS + 1000, revokedAtMs: null, revokedBy: null,
        }));
        const access = computeAccess(actor, elevations, START_MS);
        const caps = computeCapabilities({ actor, access, rules, nowMs: START_MS });
        const eff = new Set<string>(standing.filter((r) => r !== "super_admin"));
        for (const e of extra) if (e !== "super_admin" || standing.includes("super_admin")) eff.add(e);
        expect([...access.effective].sort()).toEqual([...eff].sort());
        if (access.effective.length === 0) {
          expect(Object.entries(caps).filter(([k, v]) => v && k !== "tax.read")).toEqual([]);
        }
        const a = assuranceFromAmr(amr);
        expect(a).toBe(amr.includes("passkey") || amr.includes("webauthn") ? "passkey" : amr.includes("totp") ? "totp" : "otp");
        const doc = buildAdminMe({ actor, access, elevations, amr, sessionExpiresAtMs: START_MS + 1, rules, nowMs: START_MS, ip: { allowlisted: true, source: "not_configured" }, binding: "not_passkey", devTrust: false });
        expect(doc.posture.ip_allowlisted).toBe(false);
        expect(doc.posture.device_trusted).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
