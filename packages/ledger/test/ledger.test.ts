import type { SqlClient } from "@outlet/db";
import { createTestClient } from "@outlet/db/testing";
import { money } from "@outlet/money";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIST_ENTRIES_SQL } from "../src/application/ledger.js";
import { Ledger, LedgerError } from "../src/index.js";
import { MARKET, acc, counts, cr, dr, draftOf } from "./fixtures.js";
import type { Step } from "./fixtures.js";

let client: SqlClient;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ client, close } = await createTestClient());
});
afterAll(async () => {
  await close();
});

const simple = (key: string, n = 100n, at?: Date): Step => ({
  kind: "order_recognised",
  key,
  lines: [dr(acc("psp_clearing", "paymob"), n), cr(acc("seller_pending", "S1"), n)],
  ...(at ? { at } : {}),
});
const postStep = (s: Step) => client.transaction((tx) => Ledger.post(tx, draftOf(s)));
const errorCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return e instanceof LedgerError ? e.code : `raw:${e instanceof Error ? e.message : String(e)}`;
  }
  return "NO_ERROR";
};

describe("post", () => {
  it("inserts entry, postings, chained hash and an outbox event in one transaction", async () => {
    const before = await counts(client);
    const r = await postStep(simple("post:1"));
    expect(r.replayed).toBe(false);
    const after = await counts(client);
    expect(after).toEqual({ entries: before.entries + 1, postings: before.postings + 2, outbox: before.outbox + 1 });
    const ev = await client.query<{ event_type: string; aggregate_id: string; payload: { kind: string; marketId: string; entryId: string } }>(
      "SELECT event_type, aggregate_id, payload FROM outbox_events WHERE aggregate_id = $1",
      [r.entryId],
    );
    expect(ev.rows[0]).toMatchObject({ event_type: "journal_entry.posted", payload: { kind: "order_recognised", marketId: MARKET, entryId: r.entryId } });
  });

  it("lazily creates owner-scoped accounts but not platform accounts", async () => {
    await postStep({ kind: "store_credit_granted", key: "lazy:1", lines: [dr(acc("goodwill_expense"), 5n), cr(acc("store_credit", "usr_9", "goodwill"), 5n)] });
    const row = await client.query<{ owner_type: string; owner_id: string; sub: string }>("SELECT owner_type, owner_id, sub FROM ledger_accounts WHERE code = $1", [
      "store_credit:EG:EGP:usr_9:goodwill",
    ]);
    expect(row.rows[0]).toEqual({ owner_type: "user", owner_id: "usr_9", sub: "goodwill" });
    expect(await errorCode(postStep({ kind: "clearing_settled", key: "lazy:2", lines: [dr(acc("psp_clearing", "kashier"), 5n), cr(acc("seller_pending", "S1"), 5n)] }))).toBe(
      "LEDGER_ACCOUNT_NOT_FOUND",
    );
  });

  it("rolls everything back (entry, postings, outbox, accounts) when the transaction fails after posting", async () => {
    const before = await counts(client);
    await expect(
      client.transaction(async (tx) => {
        await Ledger.post(tx, draftOf(simple("rollback:1")));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await counts(client)).toEqual(before);
    expect(await postStep(simple("rollback:1"))).toMatchObject({ replayed: false });
  });

  it("rejects an invalid draft before touching the database", async () => {
    const before = await counts(client);
    expect(await errorCode(postStep({ kind: "order_recognised", key: "bad:1", lines: [dr(acc("psp_clearing", "paymob"), 5n), cr(acc("seller_pending", "S1"), 4n)] }))).toBe(
      "LEDGER_UNBALANCED",
    );
    expect(await counts(client)).toEqual(before);
  });
});

describe("idempotency", () => {
  it("same key + same content returns the stored entry and inserts nothing", async () => {
    const first = await postStep(simple("idem:1"));
    const before = await counts(client);
    const again = await postStep({ ...simple("idem:1"), at: new Date("2030-01-01T00:00:00.000Z") });
    expect(again).toEqual({ entryId: first.entryId, replayed: true });
    expect(await counts(client)).toEqual(before);
  });

  it.each([
    ["different amounts", simple("idem:2", 100n), simple("idem:2", 101n)],
    ["different kind", simple("idem:3"), { ...simple("idem:3"), kind: "refund_issued" }],
    ["different ref", simple("idem:4"), { ...simple("idem:4"), ref: "other" }],
    ["different accounts", simple("idem:5"), { ...simple("idem:5"), lines: [dr(acc("psp_clearing", "paymob"), 100n), cr(acc("seller_pending", "S2"), 100n)] }],
  ])("same key + %s conflicts", async (_n, a, b) => {
    await postStep(a);
    const before = await counts(client);
    expect(await errorCode(postStep(b))).toBe("LEDGER_IDEMPOTENCY_CONFLICT");
    expect(await counts(client)).toEqual(before);
  });
});

describe("reverse", () => {
  it("negates every posting, links back to the original and leaves balances unchanged", async () => {
    const accounts = [acc("psp_clearing", "paymob"), acc("seller_pending", "S3")];
    const snap = async () => (await Promise.all(accounts.map((c) => Ledger.balance(client, c)))).map((m) => m.amountMinor);
    const before = await snap();
    const orig = await postStep({ ...simple("rev:1", 777n), lines: [dr(accounts[0] ?? "", 777n), cr(accounts[1] ?? "", 777n)] });
    const rev = await client.transaction((tx) => Ledger.reverse(tx, orig.entryId, { idempotencyKey: "rev:1:undo", reason: "test" }));
    expect(rev.replayed).toBe(false);
    expect(await snap()).toEqual(before);
    const row = await client.query<{ kind: string; reverses_entry_id: string; ref_type: string; ref_id: string }>(
      "SELECT kind, reverses_entry_id, ref_type, ref_id FROM journal_entries WHERE id = $1",
      [rev.entryId],
    );
    expect(row.rows[0]).toEqual({ kind: "reversal", reverses_entry_id: orig.entryId, ref_type: "journal_entry", ref_id: orig.entryId });
    const ev = await client.query<{ payload: { reason?: string } }>("SELECT payload FROM outbox_events WHERE aggregate_id = $1", [rev.entryId]);
    expect(ev.rows[0]?.payload.reason).toBe("test");
  });

  it("replay with the same key is a no-op; a second reversal with another key is refused", async () => {
    const orig = await postStep(simple("rev:2"));
    const a = await client.transaction((tx) => Ledger.reverse(tx, orig.entryId, { idempotencyKey: "rev:2:undo", reason: "r" }));
    const before = await counts(client);
    const b = await client.transaction((tx) => Ledger.reverse(tx, orig.entryId, { idempotencyKey: "rev:2:undo", reason: "r", occurredAt: new Date("2031-01-01T00:00:00.000Z") }));
    expect(b).toEqual({ entryId: a.entryId, replayed: true });
    expect(await counts(client)).toEqual(before);
    expect(await errorCode(client.transaction((tx) => Ledger.reverse(tx, orig.entryId, { idempotencyKey: "rev:2:again", reason: "r" })))).toBe("LEDGER_ALREADY_REVERSED");
  });

  it("refuses unknown entries, reversals of reversals and bad input", async () => {
    expect(await errorCode(client.transaction((tx) => Ledger.reverse(tx, "0193a000-0000-7000-8000-000000000000", { idempotencyKey: "x", reason: "r" })))).toBe("LEDGER_ENTRY_NOT_FOUND");
    const orig = await postStep(simple("rev:3"));
    const rev = await client.transaction((tx) => Ledger.reverse(tx, orig.entryId, { idempotencyKey: "rev:3:undo", reason: "r" }));
    expect(await errorCode(client.transaction((tx) => Ledger.reverse(tx, rev.entryId, { idempotencyKey: "rev:3:undo2", reason: "r" })))).toBe("LEDGER_CANNOT_REVERSE_REVERSAL");
    expect(await errorCode(client.transaction((tx) => Ledger.reverse(tx, orig.entryId, { idempotencyKey: "rev:3:e", reason: "  " })))).toBe("LEDGER_INVALID_DRAFT");
    expect(await errorCode(client.transaction((tx) => Ledger.reverse(tx, orig.entryId, { idempotencyKey: "rev:3:e", reason: "x".repeat(501) })))).toBe("LEDGER_INVALID_DRAFT");
  });
});

describe("balance and trial balance", () => {
  it("balance honours asOf (business time) and unknown accounts are zero", async () => {
    const code = acc("seller_pending", "ASOF");
    await postStep({ kind: "order_recognised", key: "asof:1", at: new Date("2026-01-01T00:00:00.000Z"), lines: [dr(acc("psp_clearing", "paymob"), 10n), cr(code, 10n)] });
    await postStep({ kind: "order_recognised", key: "asof:2", at: new Date("2026-02-01T00:00:00.000Z"), lines: [dr(acc("psp_clearing", "paymob"), 5n), cr(code, 5n)] });
    expect((await Ledger.balance(client, code)).amountMinor).toBe(-15n);
    expect((await Ledger.balance(client, code, new Date("2026-01-15T00:00:00.000Z"))).amountMinor).toBe(-10n);
    expect((await Ledger.balance(client, code, new Date("2025-12-31T00:00:00.000Z"))).amountMinor).toBe(0n);
    expect(await Ledger.balance(client, acc("seller_pending", "NEVER"))).toEqual(money(0n, "EGP"));
  });

  it("trial balance is zero per market and currency", async () => {
    expect((await Ledger.trialBalance(client, MARKET, "EGP")).amountMinor).toBe(0n);
    expect((await Ledger.trialBalance(client, "SA", "SAR")).amountMinor).toBe(0n);
  });
});

describe("hash chain", () => {
  it("is per market: a second market starts at its own genesis", async () => {
    const sa = (k: string) => client.transaction((tx) =>
      Ledger.post(tx, {
        kind: "order_recognised",
        idempotencyKey: k,
        marketId: "SA",
        occurredAt: new Date("2026-11-08T10:00:00.000Z"),
        ref: { type: "t", id: k },
        postings: [
          { accountCode: "seller_pending:SA:SAR:S1", amount: money(-5n, "SAR") },
          { accountCode: "seller_available:SA:SAR:S1", amount: money(5n, "SAR") },
        ],
      }));
    await sa("sa:1");
    await sa("sa:2");
    const seq = await client.query<{ chain_seq: string }>("SELECT chain_seq::text FROM journal_entries WHERE market_id = 'SA' ORDER BY journal_entries.chain_seq");
    expect(seq.rows.map((r) => r.chain_seq)).toEqual(["1", "2"]);
    expect(await Ledger.verifyChain(client, "SA")).toMatchObject({ ok: true, entries: 2 });
    expect((await Ledger.trialBalance(client, "SA", "SAR")).amountMinor).toBe(0n);
  });

  it("verifies end to end and an empty market verifies trivially", async () => {
    expect(await Ledger.verifyChain(client, MARKET)).toMatchObject({ ok: true });
    expect(await Ledger.verifyChain(client, "ZZ")).toMatchObject({ ok: true, entries: 0 });
  });

  it.each([
    ["a posting amount", "UPDATE postings SET amount_minor = amount_minor + 1 WHERE id = (SELECT id FROM postings WHERE entry_id = $1 ORDER BY line_no LIMIT 1)", "postings", "content hash"],
    ["the entry kind", "UPDATE journal_entries SET kind = 'refund_issued' WHERE id = $1", "journal_entries", "content hash"],
    ["the stored hash", "UPDATE journal_entries SET hash = repeat('a', 64) WHERE id = $1", "journal_entries", "entry hash"],
    ["occurred_at", "UPDATE journal_entries SET occurred_at = occurred_at + interval '1 second' WHERE id = $1", "journal_entries", "entry hash"],
    ["prev_hash", "UPDATE journal_entries SET prev_hash = repeat('b', 64) WHERE id = $1", "journal_entries", "prev_hash"],
  ])("detects tampering with %s (I20)", async (_n, sql, table, reason) => {
    const { client: c, close: done } = await createTestClient();
    try {
      const ids: string[] = [];
      for (const k of ["t1", "t2", "t3"]) {
        ids.push((await c.transaction((tx) => Ledger.post(tx, draftOf(simple(`tamper:${k}`))))).entryId);
      }
      const target = ids[1] ?? "";
      const trigger = table === "postings" ? "postings_immutable" : "journal_entries_immutable";
      await c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      await c.query(sql, [target]);
      await c.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      const v = await Ledger.verifyChain(c, MARKET);
      expect(v).toMatchObject({ ok: false, entryId: target, chainSeq: 2n });
      expect(v.ok ? "" : v.reason).toContain(reason);
    } finally {
      await done();
    }
  });

  it("detects a gap in chain_seq", async () => {
    const { client: c, close: done } = await createTestClient();
    try {
      await c.transaction((tx) => Ledger.post(tx, draftOf(simple("gap:1"))));
      const second = await c.transaction((tx) => Ledger.post(tx, draftOf(simple("gap:2"))));
      await c.query("ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_immutable");
      await c.query("UPDATE journal_entries SET chain_seq = 5 WHERE id = $1", [second.entryId]);
      const v = await Ledger.verifyChain(c, MARKET);
      expect(v).toMatchObject({ ok: false, entryId: second.entryId });
      expect(v.ok ? "" : v.reason).toContain("contiguous");
    } finally {
      await done();
    }
  });
});

describe("listEntries (keyset)", () => {
  it("pages in (occurred_at, id) order without gaps or repeats and validates input", async () => {
    const { client: c, close: done } = await createTestClient();
    try {
      for (let i = 0; i < 7; i += 1) {
        await c.transaction((tx) => Ledger.post(tx, draftOf(simple(`page:${String(i)}`, BigInt(i + 1), new Date(Date.UTC(2026, 0, 1 + (i % 3)))))));
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await Ledger.listEntries(c, { marketId: MARKET, limit: 3, ...(cursor ? { cursor } : {}) });
        pages += 1;
        seen.push(...page.entries.map((e) => e.idempotencyKey));
        for (const e of page.entries) expect(e.postings).toHaveLength(2);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(7);
      const all = await Ledger.listEntries(c, { marketId: MARKET });
      expect(all.nextCursor).toBeNull();
      expect(all.entries.map((e) => e.occurredAt)).toEqual([...all.entries.map((e) => e.occurredAt)].sort());
      expect(all.entries[0]?.postings[0]?.amount.currency).toBe("EGP");
      expect(await Ledger.listEntries(c, { marketId: "ZZ" })).toEqual({ entries: [], nextCursor: null });
      for (const limit of [0, 51, 1.5, -1]) expect(await errorCode(Ledger.listEntries(c, { marketId: MARKET, limit }))).toBe("LEDGER_INVALID_LIMIT");
      for (const cursor of ["!!!", Buffer.from("{}").toString("base64url"), Buffer.from('{"o":"x","i":"y"}').toString("base64url")]) {
        expect(await errorCode(Ledger.listEntries(c, { marketId: MARKET, cursor }))).toBe("LEDGER_INVALID_CURSOR");
      }
    } finally {
      await done();
    }
  });

  it("the keyset query uses journal_entries_keyset_idx (2,000 rows, seqscan disabled: PGlite's planner prefers a scan on tiny tables)", async () => {
    const { client: c, close: done } = await createTestClient();
    try {
      await c.query(
        `INSERT INTO ledger_accounts (id, code, type, market_id, currency, owner_type, owner_id)
         VALUES (gen_random_uuid(), 'seller_pending:EG:EGP:BULK', 'seller_pending', 'EG', 'EGP', 'store', 'BULK'),
                (gen_random_uuid(), 'seller_available:EG:EGP:BULK', 'seller_available', 'EG', 'EGP', 'store', 'BULK')`,
      );
      // Raw bulk load (bypasses the service; the deferred triggers still run and pass because each entry balances).
      await c.query(
        `WITH e AS (
           INSERT INTO journal_entries (id, kind, idempotency_key, market_id, occurred_at, ref_type, ref_id, chain_seq, content_hash, prev_hash, hash)
           SELECT gen_random_uuid(), 'line_closed', 'bulk:' || g, 'EG', timestamptz '2026-01-01' + g * interval '1 minute', 't', g::text, g,
                  repeat('c', 64), repeat('0', 64), repeat('d', 64)
             FROM generate_series(1, 2000) g RETURNING id)
         INSERT INTO postings (id, entry_id, line_no, account_id, amount_minor, currency, market_id)
         SELECT gen_random_uuid(), e.id, l.n, (SELECT id FROM ledger_accounts WHERE code = CASE l.n WHEN 1 THEN 'seller_pending:EG:EGP:BULK' ELSE 'seller_available:EG:EGP:BULK' END),
                CASE l.n WHEN 1 THEN 1 ELSE -1 END, 'EGP', 'EG'
           FROM e CROSS JOIN (VALUES (1), (2)) AS l(n)`,
      );
      await c.query("ANALYZE journal_entries");
      await c.query("SET enable_seqscan = off");
      const plan = await c.query<{ "QUERY PLAN": string }>(`EXPLAIN ${LIST_ENTRIES_SQL}`, ["EG", "2026-01-01T10:00:00.000Z", "0193a000-0000-7000-8000-000000000000", 50]);
      const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(text).toContain("journal_entries_keyset_idx");
      expect(text).not.toContain("Seq Scan");
    } finally {
      await done();
    }
  });
});
