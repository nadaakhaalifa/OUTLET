import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IntegrityConsumer, INTEGRITY_REQUESTED_EVENT } from "../src/index.js";
import { buildWorld } from "./fixtures.js";

const DAY1 = new Date("2030-01-10T01:00:00.000Z");
const DAY2 = new Date("2030-01-11T01:00:00.000Z");

describe("IntegrityJob stored result (reconciliation_runs.details, reconciliation_exceptions)", () => {
  it("a balanced ledger stores ok details with per-currency totals, the chain head and the snapshot digest", async () => {
    const w = await buildWorld();
    try {
      const store = await w.newStore();
      await w.post("store_credit_granted", `ok:${store}`, [["goodwill_expense", 700n], ["store_credit", -700n, store, "goodwill"]]);
      const r = await w.integrity.run("EG", DAY1);
      expect(r.ok).toBe(true);
      const row = (await w.raw.query<{ status: string; details: { balanced: boolean; chain_ok: boolean; chain_head: string; entries: number; totals: Record<string, string>; snapshot_sha256: string; business_date: string } }>(
        "SELECT status, details FROM reconciliation_runs WHERE source = 'ledger_integrity'")).rows;
      expect(row).toHaveLength(1);
      expect(row[0]?.status).toBe("completed");
      expect(row[0]?.details).toMatchObject({ balanced: true, chain_ok: true, entries: 1, totals: { EGP: "0" }, business_date: "2030-01-10", snapshot_sha256: r.snapshotSha256 });
      expect(row[0]?.details.chain_head).toMatch(/^[0-9a-f]{64}$/);
      expect(r.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
      expect((await w.raw.query("SELECT 1 FROM reconciliation_exceptions WHERE source = 'ledger_integrity'")).rows).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it("an unbalanced posting (triggers bypassed) is reported per entry and per currency, and the run is failed", async () => {
    const w = await buildWorld();
    try {
      const store = await w.newStore();
      await w.post("store_credit_granted", `base:${store}`, [["goodwill_expense", 700n], ["store_credit", -700n, store, "goodwill"]]);
      const acc = (await w.raw.query<{ id: string }>("SELECT id FROM ledger_accounts WHERE type = 'goodwill_expense' AND market_id = 'EG'")).rows[0]?.id;
      const entryId = randomUUID();
      await w.raw.query("ALTER TABLE postings DISABLE TRIGGER postings_entry_balanced");
      await w.raw.query("ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_min_two");
      await w.raw.query(
        `WITH e AS (INSERT INTO journal_entries (id, kind, idempotency_key, market_id, occurred_at, ref_type, ref_id, chain_seq, content_hash, prev_hash, hash)
                    VALUES ($1, 'store_credit_granted', 'rogue', 'EG', now(), 'x', 'y', 2, repeat('a', 64), repeat('b', 64), repeat('c', 64)) RETURNING id)
         INSERT INTO postings (id, entry_id, line_no, account_id, amount_minor, currency, market_id) SELECT $2, e.id, 1, $3, 100, 'EGP', 'EG' FROM e`,
        [entryId, randomUUID(), acc],
      );
      const r = await w.integrity.run("EG", DAY1);
      expect(r.ok).toBe(false);
      expect(r.checks.find((c) => c.name === "trial_balance_zero")).toMatchObject({ ok: false, detail: "EGP 100" });
      expect(r.checks.find((c) => c.name === "entries_balanced")?.ok).toBe(false);
      expect(r.checks.find((c) => c.name === "hash_chain")?.ok).toBe(false);
      const items = (await w.raw.query<{ kind: string; ref_type: string; entry_id: string | null; actual_minor: string | null; currency: string; status: string }>(
        "SELECT kind, ref_type, entry_id, actual_minor::text, currency, status FROM reconciliation_exceptions WHERE source = 'ledger_integrity' ORDER BY kind")).rows;
      expect(items.map((i) => i.kind)).toEqual(["chain_broken", "currency_total_nonzero", "entry_unbalanced"]);
      expect(items.find((i) => i.kind === "entry_unbalanced")).toMatchObject({ entry_id: entryId, actual_minor: "100", currency: "EGP", status: "OPEN" });
      const d = (await w.raw.query<{ status: string; details: { balanced: boolean; chain_ok: boolean; totals: Record<string, string> } }>("SELECT status, details FROM reconciliation_runs WHERE source = 'ledger_integrity'")).rows[0];
      expect(d).toMatchObject({ status: "failed", details: { balanced: false, chain_ok: false, totals: { EGP: "100" } } });
      // A rerun the same day replaces the run and does not duplicate the items.
      await w.integrity.run("EG", new Date(DAY1.getTime() + 3_600_000));
      expect((await w.raw.query("SELECT 1 FROM reconciliation_exceptions WHERE source = 'ledger_integrity'")).rows).toHaveLength(3);
      // A recurring exception that ops had resolved reopens on the next failing run and points at the new run.
      await w.raw.query("UPDATE reconciliation_exceptions SET status = 'RESOLVED', resolved_at = now() WHERE source = 'ledger_integrity' AND kind = 'entry_unbalanced'");
      await w.integrity.run("EG", DAY2);
      const again = (await w.raw.query<{ kind: string; status: string; same_run: boolean }>(
        `SELECT e.kind, e.status, (e.run_id = (SELECT id FROM reconciliation_runs WHERE source = 'ledger_integrity' AND business_date = '2030-01-11')) AS same_run
           FROM reconciliation_exceptions e WHERE e.source = 'ledger_integrity' ORDER BY e.kind`)).rows;
      expect(again).toHaveLength(3);
      expect(again.every((x) => x.status === "OPEN" && x.same_run)).toBe(true);
    } finally {
      await w.close();
    }
  });

  it("is idempotent per (market, day): a rerun replaces the run and keeps the same digest; a new day adds a run", async () => {
    const w = await buildWorld();
    try {
      const store = await w.newStore();
      await w.post("store_credit_granted", `idem:${store}`, [["goodwill_expense", 5n], ["store_credit", -5n, store, "goodwill"]]);
      const a = await w.integrity.run("EG", DAY1);
      const b = await w.integrity.run("EG", new Date(DAY1.getTime() + 60_000));
      expect(b.snapshotSha256).toBe(a.snapshotSha256);
      expect((await w.raw.query("SELECT 1 FROM reconciliation_runs WHERE source = 'ledger_integrity'")).rows).toHaveLength(1);
      await w.integrity.run("EG", DAY2);
      expect((await w.raw.query("SELECT 1 FROM reconciliation_runs WHERE source = 'ledger_integrity'")).rows).toHaveLength(2);
    } finally {
      await w.close();
    }
  });

  it("IntegrityConsumer: one run per tick through the inbox, duplicate and malformed events do no work", async () => {
    const w = await buildWorld();
    try {
      const c = new IntegrityConsumer(w.worker, "EG", w.integrity, () => DAY1);
      const id = randomUUID();
      const ev = { id, type: INTEGRITY_REQUESTED_EVENT, payload: { scope: "ledger_integrity", window: "ledger_integrity:2030-01-09" } };
      expect(await c.handle(ev)).toBe("processed");
      expect(await c.handle(ev)).toBe("duplicate");
      const runs = (await w.raw.query<{ business_date: string }>("SELECT business_date::text AS business_date FROM reconciliation_runs WHERE source = 'ledger_integrity'")).rows;
      expect(runs).toEqual([{ business_date: "2030-01-09" }]);
      expect(await c.handle({ id: randomUUID(), type: INTEGRITY_REQUESTED_EVENT, payload: { scope: "nope" } })).toBe("processed");
      expect(await c.handle({ id: randomUUID(), type: "other.event", payload: {} })).toBe("processed");
      expect((await w.raw.query("SELECT 1 FROM reconciliation_runs WHERE source = 'ledger_integrity'")).rows).toHaveLength(1);
    } finally {
      await w.close();
    }
  });
});
