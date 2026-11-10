import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PayoutsError, RECONCILIATION_SOURCES, settlementDraft } from "../src/index.js";
import { DAY, MONDAY, T0, buildWorld, code, scheduledPayout } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });

const postingsOf = async (key: string): Promise<{ kind: string; postings: [string, bigint][] }> => {
  const e = await w.raw.query<{ id: string; kind: string }>("SELECT id, kind FROM journal_entries WHERE idempotency_key = $1", [key]);
  const row = e.rows[0];
  if (!row) throw new Error(`no entry ${key}`);
  const p = await w.raw.query<{ code: string; amount: string }>("SELECT a.code, p.amount_minor::text AS amount FROM postings p JOIN ledger_accounts a ON a.id = p.account_id WHERE p.entry_id = $1 ORDER BY p.line_no", [row.id]);
  return { kind: row.kind, postings: p.rows.map((r) => [r.code, BigInt(r.amount)]) };
};
const n = async (sql: string, params: unknown[] = []): Promise<number> => Number((await w.raw.query<{ n: string }>(sql, params)).rows[0]?.n ?? "0");
const eventCount = (type: string): Promise<number> => n("SELECT count(*)::text AS n FROM outbox_events WHERE event_type = $1", [type]);
const HEADER = "provider_ref,kind,amount_minor,fee_minor,currency,value_date";
const NOW = new Date("2030-01-10T00:00:00.000Z");

const store = async (): Promise<string> => w.newStore();
const intent = async (o: { total: bigint; ref: string; status?: string; provider?: string; method?: string; updatedAt?: Date }): Promise<string> => {
  const s = await store();
  const r = await w.seedOrder({ storeId: s, netMinor: o.total - 1000n, totalMinor: o.total, providerRef: o.ref, intentStatus: o.status ?? "CAPTURED", provider: o.provider ?? "paymob", method: o.method ?? "card" });
  if (o.updatedAt) await w.raw.query("UPDATE payment_intents SET updated_at = $2 WHERE id = $1", [r.intentId, o.updatedAt.toISOString()]);
  return r.intentId;
};

describe("PSP settlement import", () => {
  it("matches lines to intents, posts the chart entries exactly, and flags everything else", async () => {
    const i1 = await intent({ total: 10_000n, ref: "cap-ok" });
    await intent({ total: 20_000n, ref: "cap-diff" });
    await intent({ total: 8_000n, ref: "ref-ok", status: "REFUNDED" });
    await intent({ total: 5_000n, ref: "cap-kashier", provider: "kashier" });
    const csv = [HEADER,
      "cap-ok,capture,10000,250,EGP,2030-01-05",
      "cap-diff,capture,19999,0,EGP,2030-01-05",
      "ghost,capture,700,0,EGP,2030-01-05",
      "ref-ok,refund,3000,50,EGP,2030-01-05",
      "fee-1,fee,120,0,EGP,2030-01-05",
      "cb-1,chargeback,900,0,EGP,2030-01-05",
    ].join("\n");
    const out = await w.settlements.importPsp("EG", { provider: "paymob", businessDate: "2030-01-06", format: "csv", content: csv });
    expect(out).toMatchObject({ duplicate: false, matched: 3, unmatched: 2, mismatch: 1 });

    const cap = await postingsOf("psp_settlement:paymob:capture:cap-ok");
    expect(cap.kind).toBe("clearing_settled");
    expect(cap.postings).toEqual([["bank_collections:EG:EGP:main", 9_750n], ["psp_fee_expense:EG:EGP", 250n], ["psp_clearing:EG:EGP:paymob", -10_000n]]);
    expect((await postingsOf("psp_settlement:paymob:refund:ref-ok")).postings).toEqual([["psp_clearing:EG:EGP:paymob", 3_000n], ["psp_fee_expense:EG:EGP", 50n], ["bank_collections:EG:EGP:main", -3_050n]]);
    expect((await postingsOf("psp_settlement:paymob:fee:fee-1")).postings).toEqual([["psp_fee_expense:EG:EGP", 120n], ["bank_collections:EG:EGP:main", -120n]]);
    expect(await n("SELECT count(*)::text AS n FROM journal_entries WHERE idempotency_key LIKE 'psp_settlement:%'")).toBe(3);
    const st = await w.raw.query<{ provider_ref: string; status: string; detail: string | null; intent_id: string | null }>("SELECT provider_ref, status, detail, intent_id FROM psp_settlement_lines ORDER BY line_no");
    expect(st.rows.map((r) => [r.provider_ref, r.status, r.detail])).toEqual([
      ["cap-ok", "matched", null], ["cap-diff", "mismatch", "amount_differs"], ["ghost", "unmatched", "no_payment_intent"], ["ref-ok", "matched", null], ["fee-1", "matched", null], ["cb-1", "unmatched", "manual_review"],
    ]);
    expect(st.rows[0]?.intent_id).toBe(i1);

    // the same file again is a no-op with the same summary
    const entries = await n("SELECT count(*)::text AS n FROM journal_entries");
    expect(await w.settlements.importPsp("EG", { provider: "paymob", businessDate: "2030-01-06", format: "csv", content: csv })).toMatchObject({ duplicate: true, matched: 3, unmatched: 2, mismatch: 1 });
    expect(await n("SELECT count(*)::text AS n FROM journal_entries")).toBe(entries);
    // another file that repeats a settled capture does not post it twice (the ledger key absorbs it)
    const again = await w.settlements.importPsp("EG", { provider: "paymob", businessDate: "2030-01-07", format: "json", content: JSON.stringify([{ provider_ref: "cap-ok", kind: "capture", amount_minor: "10000", fee_minor: "250", currency: "EGP", value_date: "2030-01-05" }]) });
    expect(again.matched).toBe(1);
    expect(await n("SELECT count(*)::text AS n FROM journal_entries WHERE idempotency_key = 'psp_settlement:paymob:capture:cap-ok'")).toBe(1);
    // a different amount under the same key is a conflict, reported as a mismatch rather than a second posting
    const conflict = await w.settlements.importPsp("EG", { provider: "paymob", businessDate: "2030-01-08", format: "json", content: JSON.stringify([{ provider_ref: "cap-ok", kind: "capture", amount_minor: "10000", fee_minor: "300", currency: "EGP", value_date: "2030-01-05" }]) });
    expect(conflict.mismatch).toBe(1);
    // a PSP with no seeded clearing account fails closed
    const k = await w.settlements.importPsp("EG", { provider: "kashier", businessDate: "2030-01-06", format: "csv", content: `${HEADER}\ncap-kashier,capture,5000,0,EGP,2030-01-05` });
    expect(k.mismatch).toBe(1);
    expect((await w.raw.query<{ detail: string }>("SELECT detail FROM psp_settlement_lines WHERE provider_ref = 'cap-kashier'")).rows[0]?.detail).toBe("ledger_account_not_found");
    // currency other than the market's is not posted
    await intent({ total: 6_000n, ref: "usd" });
    const usd = await w.settlements.importPsp("EG", { provider: "paymob", businessDate: "2030-01-06", format: "csv", content: `${HEADER}\nusd,capture,6000,0,USD,2030-01-05` });
    expect(usd.mismatch).toBe(1);
    expect(await code(w.settlements.importPsp("EG", { provider: "paymob", businessDate: "06/01/2030", format: "csv", content: csv }))).toBe("INVALID_INPUT");
    expect(await code(w.settlements.importPsp("EG", { provider: "paymob", businessDate: "2030-01-09", format: "csv", content: "nope" }))).toBe("INVALID_INPUT");
  });

  it("settlementDraft refuses lines it cannot post", () => {
    const base = { marketId: "EG", currency: "EGP" as const, provider: "paymob", intentId: null };
    const line = { providerRef: "r", amountMinor: 100n, feeMinor: 0n, currency: "EGP", valueDate: "2030-01-05" };
    expect(() => settlementDraft({ ...base, line: { ...line, kind: "chargeback" } })).toThrow(PayoutsError);
    expect(() => settlementDraft({ ...base, line: { ...line, kind: "capture", feeMinor: 101n } })).toThrow(PayoutsError);
    const free = settlementDraft({ ...base, line: { ...line, kind: "capture", feeMinor: 100n } });
    expect(free.postings).toHaveLength(2); // a capture eaten entirely by the fee has no zero posting
  });
});

describe("reconciliation job: exceptions, aging, escalation, resolution", () => {
  it("opens an exception per unmatched line, escalates items older than 3 days, is idempotent, and resolves after a rematch", async () => {
    const r1 = await w.recon.run("EG", "2030-01-10", NOW);
    expect(r1.sources.map((s) => s.source)).toEqual([...RECONCILIATION_SOURCES]);
    const psp = r1.sources.find((s) => s.source === "psp_settlement");
    // value date 2030-01-05 is 5 days before NOW: every PSP exception is escalated on first sight
    expect(psp?.newExceptions).toBeGreaterThanOrEqual(4);
    expect(psp?.escalated).toBe(psp?.newExceptions);
    const kinds = (await w.raw.query<{ kind: string; status: string }>("SELECT kind, status FROM reconciliation_exceptions WHERE source = 'psp_settlement' ORDER BY kind")).rows;
    expect(kinds.map((k) => k.kind)).toEqual(expect.arrayContaining(["mismatch_amount_differs", "unmatched_no_payment_intent", "unmatched_manual_review", "mismatch_ledger_account_not_found"]));
    expect(kinds.every((k) => k.status === "ESCALATED")).toBe(true);
    expect(await eventCount("reconciliation.exception")).toBeGreaterThanOrEqual(4);
    expect(await eventCount("reconciliation.escalated")).toBeGreaterThanOrEqual(4);
    expect(await n("SELECT count(*)::text AS n FROM reconciliation_matches WHERE source = 'psp_settlement'")).toBeGreaterThanOrEqual(3);

    const exceptions = await n("SELECT count(*)::text AS n FROM reconciliation_exceptions");
    const events = await eventCount("reconciliation.exception");
    const r2 = await w.recon.run("EG", "2030-01-10", NOW); // same business date and mode: same run, nothing new
    expect(r2.sources.every((s) => s.newExceptions === 0 && s.escalated === 0)).toBe(true);
    expect(await n("SELECT count(*)::text AS n FROM reconciliation_exceptions")).toBe(exceptions);
    expect(await eventCount("reconciliation.exception")).toBe(events);
    expect(await n("SELECT count(*)::text AS n FROM reconciliation_runs WHERE business_date = '2030-01-10' AND source = 'psp_settlement'")).toBe(1);

    // correct the intent amount that caused the mismatch, rematch, and the next run resolves that exception
    await w.raw.query("UPDATE payment_intents SET amount_minor = 19999 WHERE provider_ref = 'cap-diff'");
    expect(await w.settlements.rematch("EG")).toMatchObject({ matched: 1 });
    const r3 = await w.recon.run("EG", "2030-01-11", new Date(NOW.getTime() + DAY));
    expect(r3.sources.find((s) => s.source === "psp_settlement")?.resolved).toBe(1);
    const diff = (await w.raw.query<{ status: string; resolved_at: Date | null }>("SELECT status, resolved_at FROM reconciliation_exceptions WHERE kind = 'mismatch_amount_differs'")).rows[0];
    expect(diff?.status).toBe("RESOLVED");
    expect(diff?.resolved_at).not.toBeNull();
    expect(await postingsOf("psp_settlement:paymob:capture:cap-diff")).toMatchObject({ kind: "clearing_settled" });
  });

  it("exactly 3 days old is still OPEN; one more day escalates it (strictly greater than 3 days)", async () => {
    await intent({ total: 4_000n, ref: "edge" });
    await w.settlements.importPsp("EG", { provider: "paymob", businessDate: "2030-02-02", format: "csv", content: `${HEADER}\nedge,capture,3999,0,EGP,2030-02-01` });
    const exactly = new Date("2030-02-04T00:00:00.000Z"); // value date 2030-02-01T00:00Z + 3 days
    await w.recon.run("EG", "2030-02-04", exactly);
    const row = async (): Promise<string | undefined> => (await w.raw.query<{ status: string }>("SELECT e.status FROM reconciliation_exceptions e JOIN psp_settlement_lines l ON l.id = e.ref_id WHERE l.provider_ref = 'edge'")).rows[0]?.status;
    expect(await row()).toBe("OPEN");
    await w.recon.run("EG", "2030-02-05", new Date(exactly.getTime() + 1));
    expect(await row()).toBe("ESCALATED");
  });

  it("flags captured payments that never appear in a settlement file, but not COD, store credit or BNPL", async () => {
    const m = await intent({ total: 3_300n, ref: "never-settled", updatedAt: T0 });
    const codish = await intent({ total: 3_400n, ref: "cod-ish", method: "cod", provider: "none", updatedAt: T0 });
    const recent = await intent({ total: 3_500n, ref: "recent", updatedAt: new Date(NOW.getTime() - DAY) });
    await w.recon.run("EG", "2030-01-12", NOW);
    const miss = await w.raw.query<{ ref_id: string; kind: string; expected_minor: string; actual_minor: string | null }>("SELECT ref_id, kind, expected_minor::text, actual_minor::text FROM reconciliation_exceptions WHERE kind = 'missing_settlement'");
    expect(miss.rows.map((x) => x.ref_id)).toContain(m);
    expect(miss.rows.find((x) => x.ref_id === m)).toMatchObject({ expected_minor: "3300", actual_minor: null });
    expect(miss.rows.map((x) => x.ref_id)).not.toContain(codish);
    expect(miss.rows.map((x) => x.ref_id)).not.toContain(recent); // updated a day ago: not late yet
    expect(miss.rows).toHaveLength(2); // never-settled, and the REFUNDED intent from the first test whose capture line is in no file
  });
});

describe("COD remittance import (chart 4.3)", () => {
  const codOrder = async (o: { delivered: Date; withEntry?: boolean; method?: string } = { delivered: T0 }): Promise<{ sellerOrderId: string; storeId: string }> => {
    const storeId = await store();
    const r = await w.seedOrder({ storeId, netMinor: 99_480n, totalMinor: 126_000n, status: "DELIVERED", deliveredAt: o.delivered, method: o.method ?? "cod", provider: o.method === undefined || o.method === "cod" ? "none" : "paymob", providerRef: o.method === undefined || o.method === "cod" ? null : "cod-card", intentStatus: o.method === undefined || o.method === "cod" ? "NOT_REQUIRED" : "CAPTURED" });
    if (o.withEntry !== false) {
      await w.post("order_delivered_cod", `order_delivered_cod:${r.sellerOrderId}`, [
        ["cod_clearing", 126_000n, "bosta"], ["courier_cost_expense", 5_500n],
        ["seller_pending", -99_480n, storeId], ["commission_revenue", -18_000n], ["platform_vat_output", -3_257n], ["shipping_revenue", -5_263n], ["courier_payable", -5_500n, "bosta"],
      ]);
    }
    return { sellerOrderId: r.sellerOrderId, storeId };
  };

  it("posts the chart entry exactly and ignores a repeat of the same remittance", async () => {
    const o = await codOrder();
    const input = { courier: "bosta", remittanceRef: "R1", businessDate: "2030-01-08", declaredNetMinor: "120500", lines: [{ awb: "A1", sellerOrderId: o.sellerOrderId, collectedMinor: "126000", feeMinor: "5500" }] };
    const out = await w.cod.import("EG", input);
    expect(out).toMatchObject({ duplicate: false, status: "reconciled", matched: 1, unmatched: 0, mismatch: 0 });
    const e = await postingsOf("cod_remittance:bosta:R1");
    expect(e.kind).toBe("courier_remitted");
    expect(e.postings).toEqual([["bank_collections:EG:EGP:main", 120_500n], ["courier_payable:EG:EGP:bosta", 5_500n], ["cod_clearing:EG:EGP:bosta", -126_000n]]);
    expect(await w.balance("cod_clearing", "bosta")).toBe(0n);
    const entries = await n("SELECT count(*)::text AS n FROM journal_entries");
    expect(await w.cod.import("EG", input)).toMatchObject({ duplicate: true, status: "reconciled", matched: 1, entryId: out.entryId });
    expect(await n("SELECT count(*)::text AS n FROM journal_entries")).toBe(entries);
  });

  it("classifies unknown orders, missing delivery entries (I15), wrong amounts, non-COD orders and missing references; posts only matched lines", async () => {
    const good = await codOrder();
    const noEntry = await codOrder({ delivered: T0, withEntry: false });
    const wrong = await codOrder();
    const card = await codOrder({ delivered: T0, method: "card" });
    const lines = [
      { awb: "G", sellerOrderId: good.sellerOrderId, collectedMinor: "126000", feeMinor: "5500" },
      { awb: "N", sellerOrderId: noEntry.sellerOrderId, collectedMinor: "126000", feeMinor: "0" },
      { awb: "W", sellerOrderId: wrong.sellerOrderId, collectedMinor: "125000", feeMinor: "0" },
      { awb: "C", sellerOrderId: card.sellerOrderId, collectedMinor: "126000", feeMinor: "0" },
      { awb: "U", sellerOrderId: randomUUID(), collectedMinor: "1000", feeMinor: "0" },
      { awb: "X", sellerOrderId: null, collectedMinor: "500", feeMinor: "0" },
    ];
    const net = 126_000n - 5_500n + 126_000n + 125_000n + 126_000n + 1_000n + 500n;
    const out = await w.cod.import("EG", { courier: "bosta", remittanceRef: "R2", businessDate: "2030-01-08", declaredNetMinor: net.toString(), lines });
    expect(out).toMatchObject({ status: "received", matched: 1, unmatched: 3, mismatch: 2 });
    const detail = (await w.raw.query<{ awb: string; status: string; detail: string | null }>("SELECT awb, status, detail FROM cod_remittance_lines l WHERE remittance_id = $1 ORDER BY line_no", [out.remittanceId])).rows;
    expect(detail.map((d) => [d.awb, d.status, d.detail])).toEqual([
      ["G", "matched", null], ["N", "unmatched", "no_delivery_entry"], ["W", "mismatch", "amount_differs"], ["C", "mismatch", "not_a_cod_order"], ["U", "unmatched", "unknown_order"], ["X", "unmatched", "no_order_reference"],
    ]);
    expect((await postingsOf("cod_remittance:bosta:R2")).postings).toEqual([["bank_collections:EG:EGP:main", 120_500n], ["courier_payable:EG:EGP:bosta", 5_500n], ["cod_clearing:EG:EGP:bosta", -126_000n]]);
  });

  it("posts nothing when the courier's declared transfer does not equal the lines", async () => {
    const o = await codOrder();
    const out = await w.cod.import("EG", { courier: "bosta", remittanceRef: "R3", businessDate: "2030-01-08", declaredNetMinor: "100", lines: [{ awb: "M", sellerOrderId: o.sellerOrderId, collectedMinor: "126000", feeMinor: "5500" }] });
    expect(out).toMatchObject({ status: "mismatch", entryId: null });
    expect(await n("SELECT count(*)::text AS n FROM journal_entries WHERE idempotency_key = 'cod_remittance:bosta:R3'")).toBe(0);
  });

  it("rejects malformed input", async () => {
    expect(await code(w.cod.import("EG", { courier: "bosta", remittanceRef: "R4", businessDate: "x", declaredNetMinor: "1", lines: [] }))).toBe("INVALID_INPUT");
    expect(await code(w.cod.import("EG", { courier: "bosta", remittanceRef: "R5", businessDate: "2030-01-08", declaredNetMinor: "0", lines: [{ awb: "F", sellerOrderId: null, collectedMinor: "10", feeMinor: "20" }] }))).toBe("INVALID_INPUT");
  });

  it("the reconciliation run opens exceptions for lines, a mismatched remittance and COD orders never remitted (aging from delivery)", async () => {
    const lost = await codOrder({ delivered: T0 });
    const fresh = await codOrder({ delivered: new Date(NOW.getTime() - DAY) });
    await w.recon.run("EG", "2030-01-13", NOW);
    const ex = (await w.raw.query<{ kind: string; ref_id: string; status: string }>("SELECT kind, ref_id, status FROM reconciliation_exceptions WHERE source = 'cod_remittance'")).rows;
    const kinds = ex.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["remittance_total_mismatch", "unmatched_no_delivery_entry", "mismatch_amount_differs", "unmatched_unknown_order", "missing_remittance"]));
    const missing = ex.filter((e) => e.kind === "missing_remittance").map((e) => e.ref_id);
    expect(missing).toContain(lost.sellerOrderId);
    expect(missing).not.toContain(fresh.sellerOrderId); // delivered a day ago: not yet late
    expect(ex.find((e) => e.ref_id === lost.sellerOrderId)?.status).toBe("ESCALATED"); // delivered 9 days ago
  });
});

describe("store credit projection and ledger integrity", () => {
  it("a store-credit account in debit is an exception until a credit brings it back", async () => {
    const user = randomUUID();
    await w.post("store_credit_spent", `sc-bad:${user}`, [["store_credit", 500n, user, "refund_credit"], ["psp_clearing", -500n, "paymob"]]);
    const r1 = await w.recon.run("EG", "2030-01-14", NOW);
    expect(r1.sources.find((s) => s.source === "store_credit_projection")?.newExceptions).toBe(1);
    expect((await w.integrity.run("EG", NOW)).checks.find((c) => c.name === "store_credit_not_negative")?.ok).toBe(false);
    expect(await eventCount("ledger.integrity_failed")).toBe(1);
    expect((await w.raw.query<{ status: string }>("SELECT status FROM reconciliation_runs WHERE source = 'ledger_integrity'")).rows[0]?.status).toBe("failed");
    await w.post("store_credit_granted", `sc-fix:${user}`, [["goodwill_expense", 600n], ["store_credit", -600n, user, "refund_credit"]]);
    const r2 = await w.recon.run("EG", "2030-01-15", new Date(NOW.getTime() + DAY));
    expect(r2.sources.find((s) => s.source === "store_credit_projection")?.resolved).toBe(1);
    expect((await w.integrity.run("EG", new Date(NOW.getTime() + DAY))).checks.find((c) => c.name === "store_credit_not_negative")?.ok).toBe(true);
  });

  it("detects a payouts_in_transit projection drift and a seller_pending debit balance", async () => {
    const s = await store();
    const id = await scheduledPayout(w, s, 2_500n, new Date(MONDAY.getTime() + 20 * DAY));
    await w.raw.query("UPDATE payouts SET status = 'SENT' WHERE id = $1", [id]); // SENT without the ledger entry
    const report = await w.integrity.run("EG", new Date(MONDAY.getTime() + 21 * DAY));
    const drift = report.checks.find((c) => c.name === "payouts_in_transit_projection");
    expect(drift?.ok).toBe(false);
    expect(drift?.detail).toContain("2500");
    expect(report.ok).toBe(false);
    await w.raw.query("UPDATE payouts SET status = 'SCHEDULED' WHERE id = $1", [id]);
    const bad = await store();
    await w.post("refund_issued", `pending-debit:${bad}`, [["seller_pending", 100n, bad], ["psp_clearing", -100n, "paymob"]]);
    expect((await w.integrity.run("EG", new Date(MONDAY.getTime() + 22 * DAY))).checks.find((c) => c.name === "seller_pending_not_negative")?.ok).toBe(false);
  });

  it("is green on a clean ledger of its own", async () => {
    const fresh = await buildWorld();
    try {
      const r = await fresh.integrity.run("EG", NOW);
      expect(r.ok).toBe(true);
      expect(r.checks.map((c) => c.name)).toEqual(["trial_balance_zero", "entries_balanced", "hash_chain", "payouts_in_transit_projection", "seller_pending_not_negative", "store_credit_not_negative"]);
    } finally {
      await fresh.close();
    }
  });
});
