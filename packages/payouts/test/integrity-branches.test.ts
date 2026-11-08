import { describe, expect, it } from "vitest";
import { acct, pspClearingOwner, BANK_OWNER } from "../src/application/accounts.js";
import { toDate } from "../src/application/shared.js";
import { buildWorld } from "./fixtures.js";

const NOW = new Date("2030-01-10T00:00:00.000Z");

describe("IntegrityJob broken hash chain", () => {
  it("reports hash_chain failed with entry id and reason, emits the failure event, and records a failed run", async () => {
    const w = await buildWorld();
    try {
      const store = await w.newStore();
      const entryId = await w.post("store_credit_granted", `chain:${store}`, [["goodwill_expense", 700n], ["store_credit", -700n, store, "goodwill"]]);
      await w.raw.query("ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_immutable");
      await w.raw.query("UPDATE journal_entries SET hash = repeat('a', 64) WHERE id = $1", [entryId]);
      await w.raw.query("ALTER TABLE journal_entries ENABLE TRIGGER journal_entries_immutable");
      const r = await w.integrity.run("EG", NOW);
      const chain = r.checks.find((c) => c.name === "hash_chain");
      expect(r.ok).toBe(false);
      expect(chain?.ok).toBe(false);
      expect(chain?.detail).toContain(`broken at ${entryId}`);
      expect(chain?.detail).toContain("entry hash");
      const ev = await w.raw.query<{ n: string }>("SELECT count(*)::text AS n FROM outbox_events WHERE event_type = 'ledger.integrity_failed' AND payload->>'failed' LIKE '%hash_chain%'");
      expect(ev.rows[0]?.n).toBe("1");
      const run = await w.raw.query<{ status: string; unmatched_count: number }>("SELECT status, unmatched_count FROM reconciliation_runs WHERE source = 'ledger_integrity'");
      expect(run.rows[0]).toMatchObject({ status: "failed", unmatched_count: 1 });
    } finally {
      await w.close();
    }
  });
});

describe("payouts account/date helpers", () => {
  it("acct builds owner-scoped and ownerless codes; fake PSP maps to paymob", () => {
    expect(acct("seller_available", "EG", "EGP", "store-1")).toBe("seller_available:EG:EGP:store-1");
    expect(acct("payouts_in_transit", "EG", "EGP")).toBe("payouts_in_transit:EG:EGP");
    expect(pspClearingOwner("fake")).toBe("paymob");
    expect(pspClearingOwner("fawry")).toBe("fawry");
    expect(BANK_OWNER).toBe("main");
  });
  it("toDate passes a Date through by identity and parses strings", () => {
    const d = new Date("2030-02-02T00:00:00Z");
    expect(toDate(d)).toBe(d);
    expect(toDate("2030-02-02T00:00:00Z").getTime()).toBe(d.getTime());
  });
});
