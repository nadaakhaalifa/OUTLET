/**
 * Adversarial audit of the admin and privacy modules (wave 3). Every test encodes a CONFIRMED
 * defect and is expected to FAIL against the current source. Do not weaken them; fix the source.
 *
 *   ADV-W3-1  admin/domain: 5-business-day review SLA is a day short across the Cairo DST fall-back
 *   ADV-W3-2  admin: approval listing paginates before visibility filtering (approvals starve)
 *   ADV-W3-3  admin: an approved but not yet activated elevation cannot be revoked
 *   ADV-W3-4  privacy: consent withdrawal is ignored when the node clock runs behind
 *   ADV-W3-5  privacy: a grant may carry a consent text version that does not exist yet
 *   ADV-W3-6  privacy: one failing erasure starves every later due deletion (runDue)
 *   ADV-W3-7  privacy: DPO queue limit applies before the open/closed filter (overdue DSARs hidden)
 *   ADV-W3-8  privacy: completed erasure leaves the subject's export ZIP in the object store
 *   ADV-W3-9  privacy: late PDPC notice moves the subject-notice deadline later (overdue becomes pending)
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryAdminAudit,
  InMemoryAdminStore,
} from "./modules/admin/adapters/in-memory";
import { DualApprovals, RoleElevations } from "./modules/admin/application/admin";
import type { AdminAccess } from "./modules/admin/domain/access";
import { openSuspensionReview, type ApprovalRecord } from "./modules/admin/domain/bridge";
import {
  FakeBlockers,
  FakeExporter,
  InMemoryBreachRepository,
  InMemoryConsentRepository,
  InMemoryObjectStore,
  InMemoryPrivacyOutbox,
  InMemoryPrivacyRequestRepository,
  RecordingErasureExecutor,
} from "./modules/privacy/adapters/in-memory";
import { ExporterRegistry } from "./modules/privacy/application/exporters";
import { GetConsents, UpdateConsents } from "./modules/privacy/application/consents";
import { CancelDeletion, ProcessDeletions, RequestDeletion } from "./modules/privacy/application/deletion";
import { BreachRegister, ListDsarQueue } from "./modules/privacy/application/dsar";
import { ProcessExport, RequestExport } from "./modules/privacy/application/export";
import type { ErasureExecutorPort } from "./modules/privacy/domain/ports";
import type { InventoryTable } from "./modules/privacy/domain/bridge";
import { DAY, FakeClock, START_MS, sequentialIds } from "./modules/privacy/test/fixtures";

const HOUR = 3_600_000;

// ------------------------------------------------------------------ admin

describe("ADV-W3-1 suspension review SLA across the Cairo DST fall-back", () => {
  it("5 business days from Thu 2026-10-29 00:30 Cairo is due on Thu 2026-11-05", () => {
    // Egypt leaves DST at the end of Thursday 2026-10-29 (24:00 -> 23:00). Adding raw 24 h steps
    // lands twice on Thursday, so Thursday is counted as a business day after the start day.
    const start = Date.parse("2026-10-28T21:30:00Z"); // 2026-10-29 00:30 EEST
    const review = openSuspensionReview({ id: "r1", sellerId: "s1", suspendedBy: null, reasonCode: "fraud_investigation", nowMs: start });
    const dueLocalDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(review.dueAtMs));
    expect(dueLocalDate).toBe("2026-11-05");
  });
});

const access = (actorId: string, roles: AccessRoles): AdminAccess => ({
  actorId,
  standing: roles,
  effective: roles,
  breakGlassLive: false,
  passkey: true,
});
type AccessRoles = AdminAccess["standing"];
const meta = (a: AdminAccess) => ({ access: a, requestId: null });

function adminRig() {
  const clock = new FakeClock();
  const ids = sequentialIds();
  const store = new InMemoryAdminStore();
  const audit = new InMemoryAdminAudit();
  return { clock, ids, store, audit, approvals: new DualApprovals(store, audit, clock, ids), elevations: new RoleElevations(store, audit, clock, ids) };
}

describe("ADV-W3-2 approvals list is filtered after the page limit", () => {
  it("a finance approver still sees the pending refund approval buried under security-only rows", async () => {
    const r = adminRig();
    const mk = (id: string, kind: ApprovalRecord["kind"], requesterId: string, at: number): ApprovalRecord => ({
      id,
      kind,
      subjectType: "x",
      subjectId: id,
      amountMinor: null,
      reasonCode: "kyc_review",
      requesterId,
      state: "REQUESTED",
      approverId: null,
      requestedAtMs: at,
      expiresAtMs: START_MS + 10 * DAY,
      decidedAtMs: null,
      decisionNote: null,
    });
    await r.store.insertApproval(mk("refund-1", "refund", "support-user", START_MS));
    for (let i = 0; i < 5; i += 1) {
      await r.store.insertApproval(mk(`elev-${i}`, "role_elevation", "ops-user", START_MS + 1000 * (i + 1)));
    }
    const finance = access("finance-user", ["finance"]);
    const rows = await r.approvals.list(finance, { mineOnly: false, limit: 3 });
    expect(rows.map((x) => x.id)).toContain("refund-1");
  });
});

describe("ADV-W3-3 approved-but-not-activated elevation cannot be withdrawn", () => {
  it("security can revoke a pending elevation and it can then no longer be activated", async () => {
    const r = adminRig();
    const ops = access("ops-user", ["ops"]);
    const sec = access("sec-user", ["security"]);
    const created = await r.elevations.request(meta(ops), { role: "finance", reasonCode: "incident_response", ttlMs: null });
    if (created.kind !== "created") throw new Error("setup failed");
    const decided = await r.approvals.decide(meta(sec), created.approval.id, "APPROVE", null);
    expect(decided.kind).toBe("decided");

    const revoked = await r.elevations.revoke(meta(sec), created.elevation.id, true);
    expect(revoked.kind).toBe("ok");

    const activated = await r.elevations.activate(meta(ops), created.elevation.id);
    expect(activated.kind).not.toBe("ok");
  });
});

// ---------------------------------------------------------------- privacy

const USER = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const USER_C = "00000000-0000-4000-8000-000000000003";

const INVENTORY: readonly InventoryTable[] = [
  {
    name: "users",
    storage: "platform_db",
    fields: [{ name: "email", piiClass: "P2", onErasure: "delete", retention: "account_active", dsarExport: true }],
  },
];

describe("ADV-W3-4 consent withdrawal must win by append order, not by wall clock", () => {
  it("a withdrawal appended after a grant is effective even if the writing node's clock is behind", async () => {
    const repo = new InMemoryConsentRepository();
    const versions = Object.fromEntries(
      ["marketing_push", "marketing_whatsapp", "marketing_email", "analytics", "personalization", "budget_insights", "measurements", "location_precise", "cross_border_ml"].map(
        (p) => [p, 1],
      ),
    ) as ConstructorParameters<typeof UpdateConsents>[1];
    let now = Date.parse("2026-10-10T12:00:00.000Z");
    const clock = { now: () => new Date(now) };
    const update = new UpdateConsents(repo, versions, clock, () => "ab".repeat(8), sequentialIds());
    await update.execute({ userId: USER, ip: "1.1.1.1", changes: [{ purpose: "marketing_push", granted: true, version: 1 }] });
    now -= 5_000; // another node, clock 5 s behind
    await update.execute({ userId: USER, ip: "1.1.1.1", changes: [{ purpose: "marketing_push", granted: false, version: 1 }] });
    const state = await new GetConsents(repo, versions).execute(USER);
    expect(state.consents.find((c) => c.purpose === "marketing_push")?.granted).toBe(false);
  });
});

describe("ADV-W3-5 a grant must reference an existing consent text", () => {
  it("rejects a grant for a policy version above the current one", async () => {
    const repo = new InMemoryConsentRepository();
    const versions = Object.fromEntries(
      ["marketing_push", "marketing_whatsapp", "marketing_email", "analytics", "personalization", "budget_insights", "measurements", "location_precise", "cross_border_ml"].map(
        (p) => [p, 2],
      ),
    ) as ConstructorParameters<typeof UpdateConsents>[1];
    const update = new UpdateConsents(repo, versions, { now: () => new Date(START_MS) }, () => "ab".repeat(8), sequentialIds());
    const r = await update.execute({ userId: USER, ip: "1.1.1.1", changes: [{ purpose: "analytics", granted: true, version: 9 }] });
    expect(r.kind).not.toBe("ok");
  });
});

function privacyRig(executor: ErasureExecutorPort = new RecordingErasureExecutor()) {
  const clock = new FakeClock();
  const ids = sequentialIds();
  const outbox = new InMemoryPrivacyOutbox();
  const requests = new InMemoryPrivacyRequestRepository(outbox);
  const breaches = new InMemoryBreachRepository(outbox);
  const store = new InMemoryObjectStore(new Uint8Array(32).fill(7));
  const blockers = new FakeBlockers();
  const registry = new ExporterRegistry([new FakeExporter({ key: "profile", tables: ["users"] })]);
  return {
    clock,
    requests,
    store,
    requestExport: new RequestExport(requests, clock, ids),
    processExport: new ProcessExport(requests, registry, store, clock, ids),
    requestDeletion: new RequestDeletion(requests, blockers, clock, ids),
    cancelDeletion: new CancelDeletion(requests, clock, ids),
    processDeletions: new ProcessDeletions(requests, blockers, executor, () => INVENTORY, (s) => `h${s.length}`, clock, ids),
    queue: new ListDsarQueue(requests, clock),
    breaches: new BreachRegister(breaches, clock, ids),
  };
}

describe("ADV-W3-6 deletion worker head-of-line blocking", () => {
  it("a permanently failing erasure does not stop the next due deletion in the same run", async () => {
    const executor: ErasureExecutorPort = {
      async execute(input) {
        if (input.userId === USER) throw new Error("poison");
      },
    };
    const r = privacyRig(executor);
    await r.requestDeletion.execute({ userId: USER, acknowledgedForfeiture: false });
    r.clock.advance(1000);
    const b = await r.requestDeletion.execute({ userId: USER_B, acknowledgedForfeiture: false });
    if (b.kind !== "created") throw new Error("setup failed");
    r.clock.advance(15 * DAY);

    await r.processDeletions.runDue().catch(() => undefined);

    const after = await r.requests.get(b.request.id);
    expect(after?.status).toBe("completed");
  });
});

describe("ADV-W3-7 DPO queue must not hide old open requests behind newer closed ones", () => {
  it("an overdue open request is listed even when `limit` newer closed requests exist", async () => {
    const r = privacyRig();
    const old = await r.requestDeletion.execute({ userId: USER, acknowledgedForfeiture: false });
    if (old.kind !== "created") throw new Error("setup failed");
    r.clock.advance(31 * DAY);
    for (const u of [USER_B, USER_C]) {
      await r.requestDeletion.execute({ userId: u, acknowledgedForfeiture: false });
      const c = await r.cancelDeletion.execute({ userId: u });
      expect(c.kind).toBe("cancelled");
      r.clock.advance(1000);
    }
    const q = await r.queue.execute({ limit: 2, overdueOnly: true });
    expect(q.items.map((i) => i.id)).toContain(old.request.id);
    expect(q.summary.overdue).toBeGreaterThanOrEqual(1);
  });
});

describe("ADV-W3-8 erasure must remove the subject's export artifact", () => {
  it("the export ZIP created during cooling is gone once the account is erased", async () => {
    const r = privacyRig();
    const del = await r.requestDeletion.execute({ userId: USER, acknowledgedForfeiture: false });
    if (del.kind !== "created") throw new Error("setup failed");
    r.clock.advance(13 * DAY);
    const exp = await r.requestExport.execute({ userId: USER, locale: "en" });
    const ready = await r.processExport.execute(exp.request.id);
    expect(ready.kind).toBe("ready");
    const key = `exports/${USER}/${exp.request.id}.zip`;
    expect(r.store.has(key)).toBe(true);

    r.clock.advance(2 * DAY);
    const done = await r.processDeletions.execute(del.request.id);
    expect(done.kind).toBe("completed");
    expect(r.store.has(key)).toBe(false);
  });
});

describe("ADV-W3-9 breach subject-notice deadline must not slide after a late PDPC notice", () => {
  it("an overdue subject clock stays overdue once the PDPC is notified late", async () => {
    const r = privacyRig();
    const detectedAtMs = r.clock.nowMs();
    const rec = await r.breaches.record({ detectedAtMs, severity: "high", summary: "s", affectedCount: 10 });
    const id = rec.entry.id;
    await r.breaches.advance(id, "triage", "notify");
    r.clock.advance(150 * HOUR); // 72 h PDPC deadline and the 3-day follow-on (144 h) both missed
    const late = await r.breaches.advance(id, "notify_pdpc");
    if (late.kind !== "ok") throw new Error("setup failed");
    const subjects = late.view.clocks.subjects;
    expect(subjects.dueAtMs).not.toBeNull();
    expect(subjects.dueAtMs as number).toBeLessThanOrEqual(detectedAtMs + 72 * HOUR + 3 * DAY);
    expect(subjects.status).toBe("overdue");
  });
});
