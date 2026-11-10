import { createTranslator } from "@outlet/i18n";
import { describe, expect, it } from "vitest";
import { DESCRIBERS } from "../src/components/home/tileModel";

const c = { t: createTranslator("en-EG"), locale: "en-EG" as const };
const iso = "2026-11-10T08:00:00Z";
const egp = (v: string) => ({ amount_minor: v, currency: "EGP" });

describe("tile describers: the alert flag and the notes follow the data", () => {
  it("ledger integrity alerts when either the balance or the hash chain is wrong, and only then", () => {
    const d = DESCRIBERS.ledger_integrity;
    const base = { balanced: true, chain_ok: true, checked_at: iso };
    expect(d?.(base, c).alert).toBe(false);
    expect(d?.({ ...base, balanced: false }, c).alert).toBe(true);
    expect(d?.({ ...base, chain_ok: false }, c).alert).toBe(true);
    expect(d?.({ ...base, balanced: false }, c).value).toBe(c.t("admin.home.ledger.unbalanced"));
    expect(d?.({ ...base, chain_ok: false }, c).notes[0]).toContain(c.t("admin.home.ledger.chainBroken"));
    expect(d?.(base, c).value).toBe(c.t("admin.home.ledger.balanced"));
  });

  it("breaches: no deadline means no note and no alert at zero; an open breach alerts and names the deadline", () => {
    const d = DESCRIBERS.breaches_open;
    expect(d?.({ open: 0, next_pdpc_deadline_at: null, next_subjects_deadline_at: null }, c)).toMatchObject({ notes: [], alert: false, href: "/privacy" });
    const open = d?.({ open: 2, next_pdpc_deadline_at: iso, next_subjects_deadline_at: null }, c);
    expect(open?.alert).toBe(true);
    expect(open?.notes).toHaveLength(1);
  });

  it("approvals: the soonest expiry is only a note when there is one", () => {
    const d = DESCRIBERS.approvals_pending;
    expect(d?.({ for_me: 0, soonest_expires_at: null }, c)).toMatchObject({ notes: [], alert: false });
    expect(d?.({ for_me: 3, soonest_expires_at: iso }, c)).toMatchObject({ alert: true, value: "3" });
    expect(d?.({ for_me: 3, soonest_expires_at: iso }, c).notes).toHaveLength(1);
  });

  it("elevations: the own-scope reminder appears only for scope own; the tile never alerts", () => {
    const d = DESCRIBERS.elevations_active;
    expect(d?.({ active: 1, pending: 2, scope: "own" }, c).notes).toHaveLength(2);
    expect(d?.({ active: 1, pending: 2, scope: "market" }, c).notes).toHaveLength(1);
    expect(d?.({ active: 1, pending: 2, scope: "own" }, c).alert).toBeUndefined();
  });

  it("kill switches: none engaged is calm; engaged lists the names per class with 'none' for an empty class", () => {
    const d = DESCRIBERS.kill_switches;
    const calm = d?.({ engaged_money: [], engaged_ui: [] }, c);
    expect(calm).toMatchObject({ value: "0", alert: false, notes: [c.t("admin.home.note.noneEngaged")] });
    const hot = d?.({ engaged_money: ["payments.cod.enabled", "payments.card.enabled"], engaged_ui: [] }, c);
    expect(hot?.alert).toBe(true);
    expect(hot?.value).toBe("2");
    expect(hot?.notes[0]).toContain("payments.cod.enabled, payments.card.enabled");
    expect(hot?.notes[0]).toContain(c.t("admin.home.note.none"));
    expect(d?.({ engaged_money: [], engaged_ui: ["drops.enabled"] }, c).notes[0]).toContain("drops.enabled");
  });

  it("payouts alert on holds or failures, not on a plain due count", () => {
    const d = DESCRIBERS.payouts;
    const base = { due_count: 4, due_net: egp("1000"), on_hold_count: 0, on_hold_net: egp("0"), failed: 0, open_holds: 0 };
    expect(d?.(base, c).alert).toBe(false);
    expect(d?.({ ...base, on_hold_count: 1 }, c).alert).toBe(true);
    expect(d?.({ ...base, failed: 1 }, c).alert).toBe(true);
  });

  it("stale-prone counts: oldest notes only appear with a timestamp; listings carry no alert at all", () => {
    expect(DESCRIBERS.cod_awaiting_confirmation?.({ count: 0, oldest_at: null }, c)).toMatchObject({ notes: [], alert: false });
    expect(DESCRIBERS.cod_awaiting_confirmation?.({ count: 2, oldest_at: iso }, c)).toMatchObject({ alert: true });
    expect(DESCRIBERS.cod_awaiting_confirmation?.({ count: 2, oldest_at: iso }, c).notes).toHaveLength(1);
    expect(DESCRIBERS.listings_by_status?.({ published: 9, in_review: 1, paused: 0, blocked: 0 }, c).alert).toBeUndefined();
    expect(DESCRIBERS.seller_sla_breaches?.({ late_accept: 0, late_dispatch: 0, oldest_at: null }, c)).toMatchObject({ alert: false, notes: [expect.any(String)] });
    expect(DESCRIBERS.seller_sla_breaches?.({ late_accept: 0, late_dispatch: 2, oldest_at: iso }, c)).toMatchObject({ alert: true, value: "2" });
  });
});
