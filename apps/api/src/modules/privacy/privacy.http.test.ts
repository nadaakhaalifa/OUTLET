import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSENT_PURPOSES } from "@outlet/privacy";
import {
  CANCEL_DELETION,
  EXPIRE_EXPORTS,
  PRIVACY_OUTBOX,
  PROCESS_DELETIONS,
  PROCESS_EXPORT,
} from "./index";
import type { ProcessDeletions } from "./application/deletion";
import type { ExpireExports, ProcessExport } from "./application/export";
import { PRIVACY_OBJECT_STORE } from "./adapters/tokens";
import type { InMemoryObjectStore, InMemoryPrivacyOutbox } from "./adapters/in-memory";
import { DAY } from "./test/fixtures";
import { PRINCIPALS, bearer, createPrivacyHarness, type PrivacyHarness } from "./test/harness";

void CANCEL_DELETION;
const MISSING = "0192f3a4-5b6c-7d8e-9f01-0000000000ff";

let h: PrivacyHarness;
let processExport: ProcessExport;
let processDeletions: ProcessDeletions;
let expireExports: ExpireExports;
let outbox: InMemoryPrivacyOutbox;
let store: InMemoryObjectStore;

beforeAll(async () => {
  h = await createPrivacyHarness();
  processExport = h.app.get<ProcessExport>(PROCESS_EXPORT, { strict: false });
  processDeletions = h.app.get<ProcessDeletions>(PROCESS_DELETIONS, { strict: false });
  expireExports = h.app.get<ExpireExports>(EXPIRE_EXPORTS, { strict: false });
  outbox = h.app.get<InMemoryPrivacyOutbox>(PRIVACY_OUTBOX, { strict: false });
  store = h.app.get<InMemoryObjectStore>(PRIVACY_OBJECT_STORE, { strict: false });
}, 60_000);
afterAll(async () => {
  await h.close();
});

describe("POST/GET /v1/me/privacy/export", () => {
  let exportId = "";

  it("creates an async request with a 72 h target and answers a repeat with the same request", async () => {
    const r = await h.http().post("/v1/me/privacy/export").set(bearer(PRINCIPALS.alice)).send({ locale: "ar" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: "queued", locale: "ar", download_url: null, ready_at: null });
    expect(Date.parse(r.body.ready_target_at) - Date.parse(r.body.requested_at)).toBe(72 * 3_600_000);
    exportId = r.body.id;
    const again = await h.http().post("/v1/me/privacy/export").set(bearer(PRINCIPALS.alice)).send({});
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(exportId);
  });

  it("is ready after the worker runs and serves a signed URL valid for 24 hours", async () => {
    await processExport.runDue();
    const r = await h.http().get(`/v1/me/privacy/export/${exportId}`).set(bearer(PRINCIPALS.alice));
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.body.status).toBe("ready");
    expect(r.body.download_url).toMatch(/^https:\/\/exports\.invalid\/exports\//);
    expect(Date.parse(r.body.download_expires_at) - h.clock.nowMs()).toBe(24 * 3_600_000);
    expect(store.has(`exports/${PRINCIPALS.alice.actor.id}/${exportId}.zip`)).toBe(true);
    expect(outbox.events.map((e) => e.type)).toEqual(expect.arrayContaining(["privacy.export_requested", "privacy.export_ready"]));
  });

  it("GET /export/latest returns my most recent export, 401 without a token, and 404 when I never asked", async () => {
    const mine = await h.http().get("/v1/me/privacy/export/latest").set(bearer(PRINCIPALS.alice));
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ id: exportId, status: "ready" });
    expect(mine.headers["cache-control"]).toBe("private, no-store");
    expect((await h.http().get("/v1/me/privacy/export/latest")).status).toBe(401);
    expect((await h.http().get("/v1/me/privacy/export/latest").set(bearer(PRINCIPALS.bob))).status).toBe(404);
  });

  it("another user's export id is 404, exactly like an unknown id", async () => {
    const other = await h.http().get(`/v1/me/privacy/export/${exportId}`).set(bearer(PRINCIPALS.bob));
    const unknown = await h.http().get(`/v1/me/privacy/export/${MISSING}`).set(bearer(PRINCIPALS.bob));
    expect(other.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(other.body).toEqual({ ...unknown.body, request_id: other.body.request_id });
  });

  it("rejects missing credentials, a non-uuid id, unknown body fields and wrong-audience tokens", async () => {
    expect((await h.http().get(`/v1/me/privacy/export/${exportId}`)).status).toBe(401);
    // The policy guard resolves the id before body or param parsing: an id that is not a request is 404.
    expect((await h.http().get(`/v1/me/privacy/export/abc`).set(bearer(PRINCIPALS.alice))).status).toBe(404);
    expect((await h.http().post("/v1/me/privacy/export").set(bearer(PRINCIPALS.bob)).send({ locale: "fr" })).status).toBe(400);
    expect((await h.http().post("/v1/me/privacy/export").set(bearer(PRINCIPALS.bob)).send({ user_id: "x" })).status).toBe(400);
    expect((await h.http().post("/v1/me/privacy/export").set(bearer(PRINCIPALS.dpo)).send({})).status).toBe(401);
  });

  it("stops offering the link once the artifact is swept after seven days", async () => {
    h.clock.advance(7 * DAY);
    expect(await expireExports.run()).toBe(1);
    const r = await h.http().get(`/v1/me/privacy/export/${exportId}`).set(bearer(PRINCIPALS.alice));
    expect(r.body).toMatchObject({ status: "expired", download_url: null });
  });
});

describe("POST/GET/DELETE /v1/me/privacy/delete", () => {
  const bob = PRINCIPALS.bob;

  it("says exactly why when blocked", async () => {
    h.blockers.set(bob.actor.id, { openOrders: 2, openDisputes: 1 });
    const r = await h.http().post("/v1/me/privacy/delete").set(bearer(bob)).send({});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      code: "deletion_blocked",
      open_orders: 2,
      open_returns: 0,
      open_disputes: 1,
      blockers: "open_orders,open_disputes",
    });
    expect(r.body.message_ar).toContain("طلبات");
    expect(r.body.message_en).toContain("orders");
    expect((await h.http().get("/v1/me/privacy/delete").set(bearer(bob))).status).toBe(404);
  });

  it("requires acknowledging the forfeiture of store credit", async () => {
    h.blockers.set(bob.actor.id, { storeCreditMinor: 25_000n });
    const r = await h.http().post("/v1/me/privacy/delete").set(bearer(bob)).send({});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "forfeiture_acknowledgement_required", balance_amount: "25000", balance_currency: "EGP" });
  });

  it("starts a 14 day cooling period, is idempotent and can be cancelled once", async () => {
    const r = await h
      .http()
      .post("/v1/me/privacy/delete")
      .set(bearer(bob))
      .send({ acknowledge_credit_forfeiture: true });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe("cooling_off");
    expect(Date.parse(r.body.cooling_off_ends_at) - Date.parse(r.body.requested_at)).toBe(14 * DAY);
    expect(r.body.store_credit_balance).toEqual({ amount: "25000", currency: "EGP" });
    const again = await h.http().post("/v1/me/privacy/delete").set(bearer(bob)).send({});
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(r.body.id);

    const cancelled = await h.http().delete("/v1/me/privacy/delete").set(bearer(bob));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    expect((await h.http().delete("/v1/me/privacy/delete").set(bearer(bob))).status).toBe(404);
  });

  it("refuses to cancel after cooling ended, and the worker then erases per the inventory", async () => {
    h.blockers.set(bob.actor.id, {});
    h.clock.advance(1000);
    const r = await h.http().post("/v1/me/privacy/delete").set(bearer(bob)).send({});
    expect(r.status).toBe(202);
    h.clock.advance(14 * DAY - 1);
    expect((await processDeletions.runDue()).length).toBe(0);
    h.clock.advance(1);
    const late = await h.http().delete("/v1/me/privacy/delete").set(bearer(bob));
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("deletion_not_cancellable");

    const [done] = await processDeletions.runDue();
    expect(done?.kind).toBe("completed");
    expect(h.executor.calls).toHaveLength(1);
    expect(h.executor.calls[0]?.userId).toBe(bob.actor.id);
    const status = await h.http().get("/v1/me/privacy/delete").set(bearer(bob));
    expect(status.body.status).toBe("completed");
    expect(outbox.events.map((e) => e.type)).toEqual(expect.arrayContaining(["privacy.deletion_completed"]));
  });

  it("only ever acts on the caller's own request", async () => {
    expect((await h.http().get("/v1/me/privacy/delete").set(bearer(PRINCIPALS.alice))).status).toBe(404);
    expect((await h.http().delete("/v1/me/privacy/delete").set(bearer(PRINCIPALS.alice))).status).toBe(404);
    expect((await h.http().delete("/v1/me/privacy/delete")).status).toBe(401);
  });
});

describe("PATCH /v1/me/privacy/consents", () => {
  const carol = PRINCIPALS.alice;

  it("starts with nothing ticked and exposes exactly the nine purposes", async () => {
    const r = await h.http().get("/v1/me/privacy/consents").set(bearer(PRINCIPALS.bob));
    expect(r.body.consents.filter((c: { granted: boolean }) => c.granted)).toEqual([]);
    expect(CONSENT_PURPOSES).toHaveLength(9);
  });

  it("grants and then withdraws in one tap, appending history and emitting consent.changed", async () => {
    const before = outbox.events.filter((e) => e.type === "consent.changed").length;
    const grant = await h
      .http()
      .patch("/v1/me/privacy/consents")
      .set(bearer(carol))
      .send({ changes: [{ purpose: "analytics", granted: true, policy_version: "1" }] });
    expect(grant.status).toBe(200);
    expect(grant.body.consents).toEqual([expect.objectContaining({ purpose: "analytics", granted: true })]);
    const withdraw = await h
      .http()
      .patch("/v1/me/privacy/consents")
      .set(bearer(carol))
      .send({ changes: [{ purpose: "analytics", granted: false, policy_version: "1" }] });
    expect(withdraw.body.consents).toEqual([expect.objectContaining({ purpose: "analytics", granted: false })]);
    expect(outbox.events.filter((e) => e.type === "consent.changed").length - before).toBe(2);
  });

  it("rejects a tenth purpose, duplicates and unknown fields", async () => {
    const send = (body: unknown) => h.http().patch("/v1/me/privacy/consents").set(bearer(carol)).send(body as object);
    expect((await send({ changes: [{ purpose: "sms_marketing", granted: true, policy_version: "1" }] })).status).toBe(400);
    expect(
      (
        await send({
          changes: [
            { purpose: "analytics", granted: true, policy_version: "1" },
            { purpose: "analytics", granted: false, policy_version: "1" },
          ],
        })
      ).status,
    ).toBe(422);
    expect((await send({ changes: [{ purpose: "analytics", granted: true, policy_version: "1", pre_ticked: true }] })).status).toBe(400);
  });
});

describe("DPO console", () => {
  it("lists the DSAR queue for a dpo with a passkey session and audits the read", async () => {
    const r = await h.http().get("/v1/admin/privacy/requests?include_closed=true").set(bearer(PRINCIPALS.dpo));
    expect(r.status).toBe(200);
    expect(r.body.summary).toEqual(expect.objectContaining({ open: expect.any(Number), overdue: expect.any(Number) }));
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items[0]).toEqual(
      expect.objectContaining({ type: expect.stringMatching(/^(export|deletion)$/), subject_ref: expect.stringMatching(/^subj_[0-9a-f]{24}$/) }),
    );
    expect(JSON.stringify(r.body)).not.toContain(PRINCIPALS.alice.actor.id);
    expect(h.audit.entries.some((e) => e.ruleId === "privacy.dpo_console" && e.effect === "allow")).toBe(true);
  });

  it("denies every other caller: shopper token 401, misissued shopper 403, other admin roles 403", async () => {
    const paths = ["/v1/admin/privacy/requests", "/v1/admin/privacy/breaches"];
    for (const p of paths) {
      expect((await h.http().get(p).set(bearer(PRINCIPALS.alice))).status).toBe(401);
      expect((await h.http().get(p).set(bearer(PRINCIPALS.shopperOnAdminAud))).status).toBe(403);
      expect((await h.http().get(p).set(bearer(PRINCIPALS.ops))).status).toBe(403);
      expect((await h.http().get(p).set(bearer(PRINCIPALS.dpoNoPasskey))).status).toBe(403);
      expect((await h.http().get(p).set(bearer(PRINCIPALS.dpoExpired))).status).toBe(403);
      expect((await h.http().get(p)).status).toBe(401);
    }
    const write = await h
      .http()
      .post("/v1/admin/privacy/breaches")
      .set(bearer(PRINCIPALS.ops))
      .send({ detected_at: new Date(h.clock.nowMs()).toISOString(), severity: "low", summary: "x", affected_count: 0 });
    expect(write.status).toBe(403);
    expect(h.audit.entries.some((e) => e.ruleId === "privacy.dpo_console" && e.effect === "deny" && e.reason === "missing_role")).toBe(true);
  });

  it("runs a breach through its legal clocks from the injected clock", async () => {
    const detected = h.clock.nowMs() - 3_600_000;
    const created = await h
      .http()
      .post("/v1/admin/privacy/breaches")
      .set(bearer(PRINCIPALS.dpo))
      .send({ detected_at: new Date(detected).toISOString(), severity: "high", summary: "bucket exposed", affected_count: 12 });
    expect(created.status).toBe(201);
    expect(created.body.clocks.pdpc).toMatchObject({ status: "pending", due_at: new Date(detected + 72 * 3_600_000).toISOString() });
    const id = created.body.id;

    const early = await h.http().post(`/v1/admin/privacy/breaches/${id}/pdpc-notified`).set(bearer(PRINCIPALS.dpo));
    expect(early.status).toBe(409);
    const triaged = await h
      .http()
      .post(`/v1/admin/privacy/breaches/${id}/triage`)
      .set(bearer(PRINCIPALS.dpo))
      .send({ decision: "notify" });
    expect(triaged.body.status).toBe("triaged");
    expect(triaged.body.clocks.triage.status).toBe("met");

    h.clock.advance(100 * 3_600_000);
    const listed = await h.http().get("/v1/admin/privacy/breaches").set(bearer(PRINCIPALS.dpo));
    expect(listed.body.items[0].clocks.pdpc.status).toBe("overdue");
    const pdpc = await h.http().post(`/v1/admin/privacy/breaches/${id}/pdpc-notified`).set(bearer(PRINCIPALS.dpo));
    expect(pdpc.body.clocks.pdpc.status).toBe("met_late");
    const subjects = await h.http().post(`/v1/admin/privacy/breaches/${id}/subjects-notified`).set(bearer(PRINCIPALS.dpo));
    expect(subjects.body.status).toBe("subjects_notified");
    expect((await h.http().post(`/v1/admin/privacy/breaches/${id}/close`).set(bearer(PRINCIPALS.dpo))).body.status).toBe("closed");
    expect((await h.http().post(`/v1/admin/privacy/breaches/${MISSING}/close`).set(bearer(PRINCIPALS.dpo))).status).toBe(404);
  });

  it("rejects a detection time in the future and a malformed body", async () => {
    const send = (body: object) => h.http().post("/v1/admin/privacy/breaches").set(bearer(PRINCIPALS.dpo)).send(body);
    const future = new Date(h.clock.nowMs() + DAY).toISOString();
    expect((await send({ detected_at: future, severity: "low", summary: "x", affected_count: 0 })).status).toBe(400);
    expect((await send({ severity: "low" })).status).toBe(400);
  });
});
