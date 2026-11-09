import { contextClient } from "@outlet/db";
import { PgAuditStore } from "@outlet/audit-log";
import { roleClient } from "@outlet/db/testing";
import type { Principal } from "@outlet/policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BREACH_TRANSITIONS, BreachCloseBlockedError, BreachNotFoundError, BreachRegister, BreachSummaryPiiError, BreachTimestampError, BreachForbiddenError, InvalidTransitionError, breachDeadlines,
} from "../src/index.js";
import type { BreachStatus } from "../src/index.js";
import { events, setupEnv } from "./helpers.js";
import type { Env } from "./helpers.js";

let env: Env;
let reg: BreachRegister;
let appDeps: Env["deps"];
const dpo: Principal = { kind: "admin", userId: "dpo-1", marketId: "EG", roles: ["dpo"], scopes: [] };
beforeEach(async () => {
  env = await setupEnv();
  const app = contextClient(roleClient(env.client, "outlet_app"), { kind: "user", marketId: "EG" });
  appDeps = { ...env.deps, db: app, audit: new PgAuditStore(app) };
  reg = new BreachRegister(appDeps);
});
afterEach(async () => {
  await env.close();
});
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const base = { marketId: "EG", openedBy: "dpo-1", severity: "high" as const, summary: "Misconfigured bucket exposed export files for 40 minutes" };

describe("BreachRegister", () => {
  it("opens with a 72 h PDPC deadline counted from detection and emits an event", async () => {
    const detected = new Date(env.clock.t - 5 * HOUR);
    const b = await reg.open(dpo, { ...base, detectedAt: detected, dataCategories: ["contact"], subjectsEstimate: 120 });
    expect(b.status).toBe("OPEN");
    expect(b.pdpcDeadlineAt.getTime()).toBe(detected.getTime() + 72 * HOUR);
    expect(b.subjectsDeadlineAt).toBeNull();
    expect(b.dataCategories).toEqual(["contact"]);
    const ev = await events(env.client, "privacy.breach_opened");
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ breachId: b.id, severity: "high" });
  });

  it("defaults detection to now, rejects a future detection time, PII in the summary and bad input", async () => {
    const b = await reg.open(dpo, base);
    expect(b.detectedAt.getTime()).toBe(b.openedAt.getTime());
    await expect(reg.open(dpo, { ...base, detectedAt: new Date(env.clock.t + DAY) })).rejects.toBeInstanceOf(BreachTimestampError);
    await expect(reg.open(dpo, { ...base, summary: "leak of nada@example.com data" })).rejects.toBeInstanceOf(BreachSummaryPiiError);
    await expect(reg.open(dpo, { ...base, summary: "phone +20 100 123 4567 leaked" })).rejects.toBeInstanceOf(BreachSummaryPiiError);
    await expect(reg.open(dpo, { ...base, summary: "" })).rejects.toThrow();
    await expect(reg.open(dpo, { ...base, severity: "meh" as never })).rejects.toThrow();
  });

  it("walks OPEN -> TRIAGED -> PDPC_NOTIFIED -> SUBJECTS_NOTIFIED -> CLOSED with the 3 day subject deadline", async () => {
    const b = await reg.open(dpo, { ...base, subjectsEstimate: 10, detectedAt: new Date(env.clock.t - 2 * HOUR) });
    const t = await reg.update(dpo, "EG", b.id, { status: "TRIAGED", severity: "critical" });
    expect(t).toMatchObject({ status: "TRIAGED", severity: "critical" });
    const noticeAt = new Date(env.clock.t - HOUR / 2);
    const p = await reg.update(dpo, "EG", b.id, { status: "PDPC_NOTIFIED", notifiedAt: noticeAt, summary: "Updated scope", subjectsEstimate: 12, dataCategories: ["contact", "orders"] });
    expect(p.pdpcNotifiedAt).toEqual(noticeAt);
    expect(p.subjectsDeadlineAt?.getTime()).toBe(noticeAt.getTime() + 3 * DAY);
    expect(p).toMatchObject({ summary: "Updated scope", subjectsEstimate: 12, dataCategories: ["contact", "orders"] });
    await expect(reg.close(dpo, "EG", b.id, "pm-1")).rejects.toBeInstanceOf(BreachCloseBlockedError);
    const s = await reg.update(dpo, "EG", b.id, { status: "SUBJECTS_NOTIFIED" });
    expect(s.subjectsNotifiedAt).not.toBeNull();
    const c = await reg.close(dpo, "EG", b.id, "  PM-2026-11  ");
    expect(c).toMatchObject({ status: "CLOSED", postmortemRef: "PM-2026-11" });
    expect(c.closedAt).not.toBeNull();
    expect(await events(env.client, "privacy.breach_closed")).toHaveLength(1);
    expect((await events(env.client, "privacy.breach_updated")).length).toBe(3);
  });

  it("allows closing without a subject notice only when nobody is affected", async () => {
    const b = await reg.open(dpo, { ...base, subjectsEstimate: 0 });
    await reg.update(dpo, "EG", b.id, { status: "PDPC_NOTIFIED" });
    expect((await reg.close(dpo, "EG", b.id, "pm")).status).toBe("CLOSED");
  });

  it("rejects invalid transitions, including from CLOSED, and closing too early", async () => {
    const b = await reg.open(dpo, { ...base, subjectsEstimate: 0 });
    await expect(reg.update(dpo, "EG", b.id, { status: "SUBJECTS_NOTIFIED" })).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(reg.close(dpo, "EG", b.id, "pm")).rejects.toBeInstanceOf(InvalidTransitionError);
    await reg.update(dpo, "EG", b.id, { status: "PDPC_NOTIFIED" });
    await reg.close(dpo, "EG", b.id, "pm");
    await expect(reg.update(dpo, "EG", b.id, { severity: "low" })).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(reg.update(dpo, "EG", b.id, { status: "TRIAGED" })).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(reg.close(dpo, "EG", b.id, "pm")).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(reg.close(dpo, "EG", b.id, " ")).rejects.toThrow();
    await expect(reg.update(dpo, "EG", b.id, { summary: "a@b.co" })).rejects.toBeInstanceOf(BreachSummaryPiiError);
    await expect(reg.update(dpo, "EG", b.id, { status: "OPEN" as never })).rejects.toThrow();
  });

  it("every status can only move along the table", () => {
    const all = Object.keys(BREACH_TRANSITIONS) as BreachStatus[];
    expect(BREACH_TRANSITIONS.CLOSED).toEqual([]);
    for (const s of all) for (const n of BREACH_TRANSITIONS[s]) expect(all).toContain(n);
  });

  it("is market scoped: another market gets not found for get, update and close", async () => {
    const b = await reg.open(dpo, base);
    await expect(reg.get("XX", b.id)).rejects.toBeInstanceOf(BreachNotFoundError);
    await expect(reg.update({ ...dpo, marketId: "XX" }, "XX", b.id, { severity: "low" })).rejects.toBeInstanceOf(BreachNotFoundError);
    await expect(reg.close({ ...dpo, marketId: "XX" }, "XX", b.id, "pm")).rejects.toBeInstanceOf(BreachNotFoundError);
    await expect(reg.get("EG", "00000000-0000-7000-8000-000000000000")).rejects.toBeInstanceOf(BreachNotFoundError);
    expect(await reg.list("XX")).toEqual([]);
  });

  it("lists by status and flags overdue notices", async () => {
    const old = await reg.open(dpo, { ...base, detectedAt: new Date(env.clock.t - 80 * HOUR) });
    const fresh = await reg.open(dpo, base);
    const notified = await reg.open(dpo, { ...base, detectedAt: new Date(env.clock.t - 200 * HOUR) });
    await reg.update(dpo, "EG", notified.id, { status: "PDPC_NOTIFIED", notifiedAt: new Date(env.clock.t - 100 * HOUR) });
    expect((await reg.list("EG")).map((x) => x.id)).toEqual([fresh.id, old.id, notified.id]);
    expect((await reg.list("EG", "PDPC_NOTIFIED")).map((x) => x.id)).toEqual([notified.id]);
    const overdue = (await reg.overdue("EG")).map((x) => x.id).sort();
    expect(overdue).toEqual([old.id, notified.id].sort()); // old missed the PDPC notice; notified missed the 3 day subject notice
  });

  it("computes missed deadlines, counting late notices", async () => {
    const b = await reg.open(dpo, { ...base, detectedAt: new Date(env.clock.t - 10 * HOUR) });
    const now = new Date(env.clock.t);
    expect(breachDeadlines(b, now)).toEqual({ pdpcMissed: false, subjectsMissed: false });
    expect(breachDeadlines(b, new Date(now.getTime() + 70 * HOUR)).pdpcMissed).toBe(true);
    const late = { ...b, pdpcNotifiedAt: new Date(b.pdpcDeadlineAt.getTime() + 1), subjectsDeadlineAt: new Date(now.getTime() + DAY), subjectsNotifiedAt: null };
    expect(breachDeadlines(late, now)).toEqual({ pdpcMissed: true, subjectsMissed: false });
    expect(breachDeadlines(late, new Date(now.getTime() + 2 * DAY)).subjectsMissed).toBe(true);
  });

  it("runs as outlet_app: can insert, select and update allowed columns, cannot delete or rewrite history", async () => {
    const appReg = reg;
    const b = await appReg.open(dpo, base);
    await appReg.update(dpo, "EG", b.id, { status: "PDPC_NOTIFIED" });
    expect((await appReg.get("EG", b.id)).status).toBe("PDPC_NOTIFIED");
    const raw = roleClient(env.client, "outlet_app");
    await expect(raw.query("DELETE FROM breach_records")).rejects.toThrow(/permission denied/);
    await expect(raw.query("UPDATE breach_records SET detected_at = now()")).rejects.toThrow(/permission denied/);
    await expect(raw.query("UPDATE breach_records SET pdpc_deadline_at = now()")).rejects.toThrow(/permission denied/);
    for (const role of ["outlet_auth", "outlet_worker"] as const) {
      await expect(roleClient(env.client, role).query("SELECT * FROM breach_records")).rejects.toThrow(/permission denied/);
    }
  });

  it("bounds notifiedAt to detectedAt <= notifiedAt <= now and records recorded_at", async () => {
    const detected = new Date(env.clock.t - 5 * HOUR);
    const b = await reg.open(dpo, { ...base, detectedAt: detected, subjectsEstimate: 1 });
    await expect(reg.update(dpo, "EG", b.id, { status: "PDPC_NOTIFIED", notifiedAt: new Date(detected.getTime() - 1) })).rejects.toBeInstanceOf(BreachTimestampError);
    await expect(reg.update(dpo, "EG", b.id, { status: "PDPC_NOTIFIED", notifiedAt: new Date(env.clock.t + DAY) })).rejects.toBeInstanceOf(BreachTimestampError);
    const at = new Date(detected.getTime() + HOUR);
    const p = await reg.update(dpo, "EG", b.id, { status: "PDPC_NOTIFIED", notifiedAt: at });
    expect(p.pdpcNotifiedAt?.getTime()).toBe(at.getTime());
    expect(p.pdpcRecordedAt?.getTime()).toBeGreaterThan(at.getTime());
    await expect(reg.update(dpo, "EG", b.id, { status: "SUBJECTS_NOTIFIED", notifiedAt: new Date(at.getTime() - 1) })).rejects.toBeInstanceOf(BreachTimestampError);
    const s = await reg.update(dpo, "EG", b.id, { status: "SUBJECTS_NOTIFIED" });
    expect(s.subjectsRecordedAt).not.toBeNull();
  });

  it("writes a chain entry per open/update/close with ids, enums and timestamps only", async () => {
    const b = await reg.open(dpo, { ...base, subjectsEstimate: 0 });
    await reg.update(dpo, "EG", b.id, { status: "PDPC_NOTIFIED" });
    await reg.close(dpo, "EG", b.id, "pm-1");
    const rows = (await env.client.query<{ action: string; diff: { before: unknown; after: Record<string, unknown> }; actor_id: string; target_id: string }>(
      "SELECT action, diff, actor_id, target_id FROM audit_log WHERE target_type = 'breach' ORDER BY seq")).rows;
    expect(rows.map((r) => r.action)).toEqual(["privacy.breach.opened", "privacy.breach.updated", "privacy.breach.closed"]);
    expect(rows.every((r) => r.target_id === b.id && r.actor_id === "dpo-1")).toBe(true);
    expect(rows[0]?.diff.before).toBeNull();
    expect(rows[1]?.diff.after).toMatchObject({ status: "PDPC_NOTIFIED" });
    expect(JSON.stringify(rows)).not.toContain("bucket");
    expect(await new PgAuditStore(contextClient(roleClient(env.client, "outlet_app"), { kind: "user", marketId: "EG" })).verifyChain("EG")).toMatchObject({ ok: true, checked: 3 });
  });

  it("denies actors without the policy action and requires an audit store", async () => {
    const shopper: Principal = { kind: "shopper", userId: "u", marketId: "EG", roles: [], scopes: [] };
    const sec: Principal = { kind: "admin", userId: "s", marketId: "EG", roles: ["security"], scopes: [] };
    const other: Principal = { ...dpo, marketId: "XX" };
    await expect(reg.open(shopper, base)).rejects.toBeInstanceOf(BreachForbiddenError);
    await expect(reg.open(other, base)).rejects.toBeInstanceOf(BreachForbiddenError);
    const b = await reg.open(sec, base); // security may open
    await expect(reg.update(sec, "EG", b.id, { status: "TRIAGED" })).rejects.toBeInstanceOf(BreachForbiddenError);
    await expect(reg.close(sec, "EG", b.id, "x")).rejects.toBeInstanceOf(BreachForbiddenError);
    expect((await reg.get("EG", b.id)).status).toBe("OPEN");
    const noAudit = new BreachRegister({ db: appDeps.db, outbox: appDeps.outbox });
    await expect(noAudit.open(dpo, base)).rejects.toThrow(/audit store/);
    await expect(reg.open({ ...sec, userId: undefined }, { ...base, openedBy: undefined })).rejects.toBeInstanceOf(BreachTimestampError);
  });
});
