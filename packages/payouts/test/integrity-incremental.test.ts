import { randomUUID } from "node:crypto";
import { brandClient } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { chainHash, contentHash } from "@outlet/ledger";
import { describe, expect, it } from "vitest";
import { INTEGRITY_REQUESTED_EVENT, IntegrityConsumer, IntegrityJob } from "../src/index.js";
import { buildWorld } from "./fixtures.js";
import type { World } from "./fixtures.js";

const DAY1 = new Date("2030-01-10T01:00:00.000Z");
const DAY2 = new Date("2030-01-11T01:00:00.000Z"); // a Friday
const OCCURRED = "2030-01-01T00:00:00.000Z";

interface Head { seq: bigint; hash: string; expenseId: string; creditId: string; expenseCode: string; creditCode: string }

/** One real entry (creates the accounts), then `extra` synthetic entries with valid hashes appended in two multi-row statements. */
const seedChain = async (w: World, extra: number, tag: string): Promise<void> => {
  if ((await w.raw.query("SELECT 1 FROM journal_entries")).rows.length === 0) {
    const store = await w.newStore();
    await w.post("store_credit_granted", `real:${store}`, [["goodwill_expense", 700n], ["store_credit", -700n, store, "goodwill"]]);
  }
  const last = (await w.raw.query<{ seq: string; hash: string }>("SELECT chain_seq::text AS seq, hash FROM journal_entries WHERE market_id = 'EG' ORDER BY chain_seq DESC LIMIT 1")).rows[0];
  const acc = (await w.raw.query<{ id: string; code: string; type: string }>("SELECT id, code, type FROM ledger_accounts WHERE type IN ('goodwill_expense', 'store_credit') AND market_id = 'EG' ORDER BY type")).rows;
  const expense = acc.find((a) => a.type === "goodwill_expense");
  const credit = acc.find((a) => a.type === "store_credit");
  if (last === undefined || expense === undefined || credit === undefined) throw new Error("seed prerequisites missing");
  const head: Head = { seq: BigInt(last.seq), hash: last.hash, expenseId: expense.id, creditId: credit.id, expenseCode: expense.code, creditCode: credit.code };
  const ids: string[] = [];
  const keys: string[] = [];
  const seqs: string[] = [];
  const contents: string[] = [];
  const prevs: string[] = [];
  const hashes: string[] = [];
  let prev = head.hash;
  for (let i = 0; i < extra; i += 1) {
    const id = randomUUID();
    const seq = head.seq + 1n + BigInt(i);
    const key = `syn:${tag}:${String(i)}`;
    const content = contentHash({ kind: "store_credit_granted", idempotencyKey: key, marketId: "EG", refType: "test", refId: key, reversesEntryId: null,
      postings: [{ accountCode: head.expenseCode, amountMinor: 1n, currency: "EGP" }, { accountCode: head.creditCode, amountMinor: -1n, currency: "EGP" }] });
    const hash = chainHash({ id, chainSeq: seq, contentHash: content, occurredAt: OCCURRED, prevHash: prev });
    ids.push(id); keys.push(key); seqs.push(seq.toString()); contents.push(content); prevs.push(prev); hashes.push(hash);
    prev = hash;
  }
  await w.raw.transaction(async (tx: Queryable) => {
    await tx.query(
      `INSERT INTO journal_entries (id, kind, idempotency_key, market_id, occurred_at, ref_type, ref_id, chain_seq, content_hash, prev_hash, hash)
       SELECT i, 'store_credit_granted', k, 'EG', $7::timestamptz, 'test', k, s, c, p, h
         FROM unnest($1::uuid[], $2::text[], $3::bigint[], $4::text[], $5::text[], $6::text[]) AS t(i, k, s, c, p, h)`,
      [ids, keys, seqs, contents, prevs, hashes, OCCURRED],
    );
    await tx.query(
      `INSERT INTO postings (id, entry_id, line_no, account_id, amount_minor, currency, market_id)
       SELECT gen_random_uuid(), e, v.l, CASE v.l WHEN 1 THEN $2::uuid ELSE $3::uuid END, CASE v.l WHEN 1 THEN 1 ELSE -1 END, 'EGP', 'EG'
         FROM unnest($1::uuid[]) AS e CROSS JOIN (VALUES (1), (2)) AS v(l)`,
      [ids, head.expenseId, head.creditId],
    );
  });
};

const tamper = async (w: World, seq: number, sql: string): Promise<void> => {
  await w.raw.query("ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_immutable");
  await w.raw.query(`UPDATE journal_entries SET ${sql} WHERE chain_seq = $1`, [seq]);
  await w.raw.query("ALTER TABLE journal_entries ENABLE TRIGGER journal_entries_immutable");
};

const job = (w: World, o: { budgetMs: number; pageSize: number; client?: RoleSqlClient<"outlet_worker"> }): IntegrityJob =>
  new IntegrityJob({ client: o.client ?? w.worker, currency: "EGP", now: () => DAY1, budgetMs: o.budgetMs, pageSize: o.pageSize });

const runRow = async (w: World, date: string): Promise<{ status: string; details: Record<string, unknown> } | undefined> =>
  (await w.raw.query<{ status: string; details: Record<string, unknown> }>("SELECT status, details FROM reconciliation_runs WHERE source = 'ledger_integrity' AND business_date = $1::date", [date])).rows[0];

describe("incremental chain verification", () => {
  it("a 25,000-entry ledger is verified across 3 ticks with a spent budget, 10,000 entries per page, and completes with the same verdict as a full pass", async () => {
    const w = await buildWorld();
    try {
      await seedChain(w, 24_999, "a");
      const j = job(w, { budgetMs: 0, pageSize: 10_000 });
      const t1 = await j.run("EG", DAY1);
      expect(t1).toMatchObject({ complete: false, verifiedThroughSeq: 10_000n, ok: true });
      expect(await runRow(w, "2030-01-10")).toMatchObject({ status: "running", details: { complete: false, verified_through_seq: "10000" } });
      const t2 = await j.run("EG", DAY1);
      expect(t2).toMatchObject({ complete: false, verifiedThroughSeq: 20_000n });
      const t3 = await j.run("EG", DAY1);
      expect(t3).toMatchObject({ complete: true, ok: true, verifiedThroughSeq: 25_000n });
      const row = await runRow(w, "2030-01-10");
      expect(row).toMatchObject({ status: "completed", details: { complete: true, verified_through_seq: "25000", chain_ok: true, entries: 25_000, full: false } });
      // The two unfinished ticks each emitted one continuation; the finished one did not.
      const ev = (await w.raw.query<{ payload: { scope: string; window: string; continuation: number } }>("SELECT payload FROM outbox_events WHERE event_type = $1 ORDER BY (payload->>'continuation')::int", [INTEGRITY_REQUESTED_EVENT])).rows;
      expect(ev.map((e) => e.payload.continuation)).toEqual([1, 1]);
      expect(ev[0]?.payload).toMatchObject({ scope: "ledger_integrity", window: "ledger_integrity:2030-01-10" });
      // The head the incremental run stored is the real head, so the digest equals the one a single full-budget pass produces.
      const full = await job(w, { budgetMs: 60_000, pageSize: 10_000 }).run("EG", DAY1, "2030-01-10", { full: true });
      expect(full.snapshotSha256).toBe(t3.snapshotSha256);
      expect((await w.raw.query("SELECT 1 FROM reconciliation_exceptions WHERE source = 'ledger_integrity'")).rows).toHaveLength(0);
    } finally {
      await w.close();
    }
  }, 120_000);

  it("resumes from the last stored page after a crash mid-run (does not restart from entry 1)", async () => {
    const w = await buildWorld();
    try {
      await seedChain(w, 350, "b");
      let calls = 0;
      const crashing = brandClient<"outlet_worker">({
        query: (sql, params) => w.worker.query(sql, params),
        transaction: (fn) => {
          calls += 1;
          if (calls === 4) return Promise.reject(new Error("simulated crash"));
          return w.worker.transaction(fn);
        },
      });
      // transactions: 1 = load cursor, 2 and 3 = pages 1-100 and 101-200, 4 = crash before page 201-300.
      await expect(job(w, { budgetMs: 60_000, pageSize: 100, client: crashing }).run("EG", DAY1)).rejects.toThrow("simulated crash");
      expect(await runRow(w, "2030-01-10")).toMatchObject({ status: "running", details: { verified_through_seq: "200", complete: false } });
      const resumed = await job(w, { budgetMs: 60_000, pageSize: 100 }).advance("EG", DAY1, "2030-01-10");
      expect(resumed).toMatchObject({ complete: true, broken: null, pages: 2 }); // 201-300, 301-351 (not 4 pages from scratch)
      expect(resumed.cursor.seq).toBe(351n);
    } finally {
      await w.close();
    }
  }, 60_000);

  it("a tamper in the newest entries is caught by the next nightly run: failed run, one chain_broken exception, ledger.integrity_failed, cursor kept before the break", async () => {
    const w = await buildWorld();
    try {
      await seedChain(w, 300, "c");
      const j = job(w, { budgetMs: 60_000, pageSize: 100 });
      expect((await j.run("EG", DAY1)).ok).toBe(true);
      await seedChain(w, 60, "c2");
      await tamper(w, 340, "hash = repeat('a', 64)");
      const r = await j.run("EG", DAY2, "2030-01-11");
      expect(r.ok).toBe(false);
      expect(r.checks.find((c) => c.name === "hash_chain")?.detail).toContain("broken at");
      const row = await runRow(w, "2030-01-11");
      expect(row).toMatchObject({ status: "failed", details: { chain_ok: false, complete: false } });
      expect(BigInt(String(row?.details.verified_through_seq))).toBeLessThan(340n);
      await j.run("EG", DAY2, "2030-01-11"); // rerun: same exception key, no duplicate
      const items = (await w.raw.query<{ kind: string }>("SELECT kind FROM reconciliation_exceptions WHERE source = 'ledger_integrity'")).rows;
      expect(items).toEqual([{ kind: "chain_broken" }]);
      expect((await w.raw.query("SELECT 1 FROM outbox_events WHERE event_type = 'ledger.integrity_failed'")).rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      await w.close();
    }
  }, 60_000);

  it("a tamper in already-verified history is NOT caught by the incremental run but IS caught by the full pass (cursor reset to 0)", async () => {
    const w = await buildWorld();
    try {
      await seedChain(w, 300, "d");
      const j = job(w, { budgetMs: 60_000, pageSize: 100 });
      expect((await j.run("EG", DAY1)).ok).toBe(true);
      await tamper(w, 5, "ref_id = 'tampered'");
      await seedChain(w, 20, "d2");
      const nightly = await j.run("EG", DAY2, "2030-01-11");
      expect(nightly).toMatchObject({ ok: true, complete: true, verifiedThroughSeq: 321n }); // trade-off: old history is trusted between full passes
      const full = await j.run("EG", DAY2, "2030-01-11", { full: true });
      expect(full.ok).toBe(false);
      expect(full.checks.find((c) => c.name === "hash_chain")?.detail).toContain("content hash");
      expect(await runRow(w, "2030-01-11")).toMatchObject({ status: "failed", details: { full: true, verified_through_seq: "4" } });
      const items = (await w.raw.query<{ kind: string }>("SELECT kind FROM reconciliation_exceptions WHERE source = 'ledger_integrity'")).rows;
      expect(items).toEqual([{ kind: "chain_broken" }]);
    } finally {
      await w.close();
    }
  }, 60_000);

  it("consumer: an unfinished run emits its own continuation event; handling it resumes; a full event resets once and a redelivery is a duplicate", async () => {
    const w = await buildWorld();
    try {
      await seedChain(w, 250, "e");
      const j = job(w, { budgetMs: 0, pageSize: 100 });
      const c = new IntegrityConsumer(w.worker, "EG", j, () => DAY1);
      const first = { id: randomUUID(), type: INTEGRITY_REQUESTED_EVENT, payload: { scope: "ledger_integrity", window: "ledger_integrity:2030-01-10" } };
      expect(await c.handle(first)).toBe("processed");
      expect(await c.handle(first)).toBe("duplicate");
      interface Ev { id: string; type: string; payload: Record<string, unknown> }
      const cont = async (): Promise<Ev[]> =>
        (await w.raw.query<{ id: string; payload: Record<string, unknown> }>("SELECT id, payload FROM outbox_events WHERE event_type = $1 ORDER BY (payload->>'continuation')::int, occurred_at", [INTEGRITY_REQUESTED_EVENT])).rows.map((r) => ({ ...r, type: INTEGRITY_REQUESTED_EVENT }));
      expect(await cont()).toHaveLength(1);
      expect((await cont())[0]?.payload).toMatchObject({ continuation: 1 });
      for (let n = 0; n < 5 && (await runRow(w, "2030-01-10"))?.status !== "completed"; n += 1) {
        const handled = new Set((await w.raw.query<{ message_id: string }>("SELECT message_id FROM inbox_processed WHERE consumer = 'finance.integrity'")).rows.map((r) => r.message_id));
        const next = (await cont()).find((e) => !handled.has(e.id));
        if (next === undefined) throw new Error("no continuation");
        expect(await c.handle(next)).toBe("processed");
      }
      expect(await runRow(w, "2030-01-10")).toMatchObject({ status: "completed", details: { verified_through_seq: "251", complete: true } });
      // A full event for a later date resets the cursor: its first tick restarts at entry 1 (cursor 100 after one page).
      const full = { id: randomUUID(), type: INTEGRITY_REQUESTED_EVENT, payload: { scope: "ledger_integrity_full", window: "ledger_integrity_full:2030-01-11" } };
      expect(await c.handle(full)).toBe("processed");
      expect(await runRow(w, "2030-01-11")).toMatchObject({ status: "running", details: { full: true, verified_through_seq: "100" } });
      const fullCont = (await cont()).filter((e) => e.payload.scope === "ledger_integrity_full");
      expect(fullCont).toHaveLength(1);
      expect(fullCont[0]?.payload).toMatchObject({ window: "ledger_integrity_full:2030-01-11", continuation: 1 });
      // The continuation does not reset again (that date already is a full run): it goes on from 100 to 200.
      expect(await c.handle(fullCont[0]!)).toBe("processed");
      expect(await runRow(w, "2030-01-11")).toMatchObject({ details: { verified_through_seq: "200" } });
    } finally {
      await w.close();
    }
  }, 60_000);
});
