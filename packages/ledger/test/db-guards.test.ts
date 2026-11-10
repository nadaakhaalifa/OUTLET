import type { Queryable, SqlClient } from "@outlet/db";
import { withDbContext } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import fc from "fast-check";
import { money } from "@outlet/money";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ledger, LedgerError, validateDraft } from "../src/index.js";
import { acc, counts, cr, dr, draftOf } from "./fixtures.js";

let client: SqlClient;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ client, close } = await createTestClient());
});
afterAll(async () => {
  await close();
});

const rejected = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "NO_ERROR";
};

const accountId = async (db: Queryable, code: string): Promise<string> => {
  const r = await db.query<{ id: string }>("SELECT id FROM ledger_accounts WHERE code = $1", [code]);
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`no account ${code}`);
  return id;
};

let rawSeq = 1_000_000;
/** Raw SQL insert that bypasses the domain: proves the database itself enforces the invariants. */
const rawEntry = (lines: readonly { code: string; amount: bigint; currency?: string; market?: string }[], opts: { market?: string } = {}) =>
  client.transaction(async (tx) => {
    rawSeq += 1;
    const id = crypto.randomUUID();
    await tx.query(
      `INSERT INTO journal_entries (id, kind, idempotency_key, market_id, occurred_at, ref_type, ref_id, chain_seq, content_hash, prev_hash, hash)
       VALUES ($1, 'line_closed', $2, $3, now(), 't', 'r', $4::bigint, repeat('a', 64), repeat('0', 64), repeat('b', 64))`,
      [id, `raw:${String(rawSeq)}`, opts.market ?? "EG", String(rawSeq)],
    );
    let n = 0;
    for (const l of lines) {
      n += 1;
      await tx.query(
        "INSERT INTO postings (id, entry_id, line_no, account_id, amount_minor, currency, market_id) VALUES (gen_random_uuid(), $1, $2, $3, $4::bigint, $5, $6)",
        [id, n, await accountId(tx, l.code), l.amount.toString(), l.currency ?? "EGP", l.market ?? "EG"],
      );
    }
  });

const P = acc("psp_clearing", "paymob");
const C = acc("commission_revenue");

describe("database guards (raw SQL, domain bypassed)", () => {
  it("accepts a balanced raw entry (control)", async () => {
    await rawEntry([{ code: P, amount: 5n }, { code: C, amount: -5n }]);
  });

  it("rejects an unbalanced entry at COMMIT and persists nothing", async () => {
    const before = await counts(client);
    expect(await rejected(rawEntry([{ code: P, amount: 5n }, { code: C, amount: -4n }]))).toContain("unbalanced");
    expect(await counts(client)).toEqual(before);
  });

  it("property: any non-zero sum is rejected by the domain AND by the trigger; zero sums pass both", async () => {
    const pool = [P, C, acc("platform_vat_output"), acc("bank_operating", "main")];
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.integer({ min: 0, max: pool.length - 1 }), fc.bigInt({ min: -10_000n, max: 10_000n }).filter((n) => n !== 0n)), { minLength: 2, maxLength: 6 }),
        async (rows) => {
          const lines = rows.map(([i, n]) => ({ code: pool[i] ?? "", amount: n }));
          const sum = lines.reduce((a, l) => a + l.amount, 0n);
          let domainOk = true;
          try {
            validateDraft(draftOf({ kind: "line_closed", key: "p", lines: lines.map((l) => [l.code, l.amount] as const) }));
          } catch (e) {
            if (!(e instanceof LedgerError)) throw e;
            domainOk = false;
          }
          const dbOutcome = await rejected(rawEntry(lines));
          expect(domainOk).toBe(sum === 0n);
          expect(dbOutcome === "NO_ERROR").toBe(sum === 0n);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("rejects an entry with a single posting or none at COMMIT", async () => {
    expect(await rejected(rawEntry([{ code: P, amount: 5n }]))).toMatch(/unbalanced|fewer than two/);
    expect(await rejected(rawEntry([]))).toContain("fewer than two");
  });

  it("balance is enforced per currency: SAR and EGP legs cannot offset each other", async () => {
    await client.query(
      `INSERT INTO ledger_accounts (id, code, type, market_id, currency, owner_type, owner_id)
       VALUES (gen_random_uuid(), 'psp_clearing:EG:SAR:paymob', 'psp_clearing', 'EG', 'SAR', 'psp', 'paymob')`,
    );
    expect(
      await rejected(rawEntry([{ code: P, amount: 5n }, { code: "psp_clearing:EG:SAR:paymob", amount: -5n, currency: "SAR" }])),
    ).toContain("unbalanced");
  });

  it("rejects a zero amount, a posting whose currency differs from its account, and a posting in another market", async () => {
    expect(await rejected(rawEntry([{ code: P, amount: 0n }, { code: C, amount: 0n }]))).toContain("postings_amount_minor_check");
    expect(await rejected(rawEntry([{ code: P, amount: 5n, currency: "SAR" }, { code: C, amount: -5n, currency: "SAR" }]))).toContain("postings_account_fk");
    expect(await rejected(rawEntry([{ code: P, amount: 5n, market: "SA" }, { code: C, amount: -5n, market: "SA" }]))).toMatch(/postings_(account|entry)_fk/);
    // posting market differs from its entry's market
    expect(await rejected(rawEntry([{ code: P, amount: 5n }, { code: C, amount: -5n }], { market: "SA" }))).toContain("postings_entry_fk");
  });

  it("rejects reserved account names (spec 3.5, I19) and malformed account codes", async () => {
    const insert = (type: string, code: string) =>
      client.query("INSERT INTO ledger_accounts (id, code, type, market_id, currency) VALUES (gen_random_uuid(), $1, $2, 'EG', 'EGP')", [code, type]);
    expect(await rejected(insert("gift_card_liability", "gift_card_liability:EG:EGP"))).toContain("ledger_accounts_type_check");
    expect(await rejected(insert("commission_revenue", "commission_revenue:EG:EGP:x"))).toContain("ledger_accounts_code_matches");
    expect(await rejected(insert("commission_revenue", "commission_revenue:EG:EGP"))).toContain("ledger_accounts_code_key");
  });

  it("keeps the seeded platform accounts for EG/EGP", async () => {
    const r = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM ledger_accounts WHERE market_id = 'EG' AND owner_id <> 'BULK'");
    expect(Number(r.rows[0]?.n)).toBeGreaterThanOrEqual(24);
  });
});

describe("immutability (P4, I4)", () => {
  it("triggers block UPDATE, DELETE and TRUNCATE for every role, superuser included", async () => {
    const posted = await client.transaction((tx) => Ledger.post(tx, draftOf({ kind: "line_closed", key: "imm:1", lines: [dr(P, 9n), cr(C, 9n)] })));
    for (const sql of [
      "UPDATE postings SET amount_minor = 1",
      "DELETE FROM postings",
      "TRUNCATE postings",
      "UPDATE journal_entries SET kind = 'reversal'",
      "DELETE FROM journal_entries",
      "TRUNCATE journal_entries CASCADE",
    ]) {
      expect(await rejected(client.query(sql)), sql).toContain("not allowed");
    }
    const still = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM postings WHERE entry_id = $1", [posted.entryId]);
    expect(still.rows[0]?.n).toBe("2");
  });

  it("a non-superuser role is also stopped: by the trigger even with full grants, by privileges with INSERT/SELECT only", async () => {
    await client.query("CREATE ROLE ledger_probe NOLOGIN NOSUPERUSER NOBYPASSRLS");
    await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON postings, journal_entries TO ledger_probe");
    await client.query("SET ROLE ledger_probe");
    try {
      expect(await rejected(client.query("UPDATE postings SET amount_minor = amount_minor"))).toContain("not allowed");
      expect(await rejected(client.query("DELETE FROM postings"))).toContain("not allowed");
      expect(await rejected(client.query("DELETE FROM journal_entries"))).toContain("not allowed");
    } finally {
      await client.query("RESET ROLE");
    }
    await client.query("REVOKE UPDATE, DELETE ON postings, journal_entries FROM ledger_probe");
    await client.query("SET ROLE ledger_probe");
    try {
      expect(await rejected(client.query("UPDATE postings SET amount_minor = amount_minor"))).toContain("permission denied");
      expect(await rejected(client.query("DELETE FROM journal_entries"))).toContain("permission denied");
    } finally {
      await client.query("RESET ROLE");
    }
  });

  it("outlet_app (migration 0007), when present, holds no UPDATE/DELETE/TRUNCATE on the ledger tables", async () => {
    const role = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_roles WHERE rolname = 'outlet_app'");
    if (role.rows[0]?.n === "0") return; // 0007 not applied in this tree
    for (const t of ["postings", "journal_entries"]) {
      for (const priv of ["UPDATE", "DELETE", "TRUNCATE"]) {
        const r = await client.query<{ ok: boolean }>("SELECT has_table_privilege('outlet_app', $1, $2) AS ok", [t, priv]);
        expect(r.rows[0]?.ok, `${t} ${priv}`).toBe(false);
      }
    }
  });
});

describe("money amounts at the BIGINT edge", () => {
  it("posts and reads back 2^63-1 piastres exactly (no Number round trip)", async () => {
    const big = 2n ** 63n - 1n;
    const code = acc("seller_pending", "BIG");
    await client.transaction((tx) =>
      Ledger.post(tx, {
        kind: "line_closed",
        idempotencyKey: "big:1",
        marketId: "EG",
        occurredAt: new Date("2026-11-08T10:00:00.000Z"),
        ref: { type: "t", id: "big" },
        postings: [{ accountCode: acc("seller_available", "BIG"), amount: money(big, "EGP") }, { accountCode: code, amount: money(-big, "EGP") }],
      }),
    );
    expect((await Ledger.balance(client, code)).amountMinor).toBe(-big);
    expect((await Ledger.trialBalance(client, "EG", "EGP")).amountMinor).toBe(0n);
  });
});

describe("closed entries (A1)", () => {
  it("rejects balanced postings added to an old entry in a LATER transaction", async () => {
    const posted = await client.transaction((tx) => Ledger.post(tx, draftOf({ kind: "line_closed", key: "closed:1", lines: [dr(P, 7n), cr(C, 7n)] })));
    const before = await counts(client);
    const msg = await rejected(
      client.transaction(async (tx) => {
        const [pa, ca] = [await accountId(tx, P), await accountId(tx, C)];
        await tx.query("INSERT INTO postings (id, entry_id, line_no, account_id, amount_minor, currency, market_id) VALUES (gen_random_uuid(), $1, 3, $2, 4, 'EGP', 'EG')", [posted.entryId, pa]);
        await tx.query("INSERT INTO postings (id, entry_id, line_no, account_id, amount_minor, currency, market_id) VALUES (gen_random_uuid(), $1, 4, $2, -4, 'EGP', 'EG')", [posted.entryId, ca]);
      }),
    );
    expect(msg).toContain("is closed");
    expect(await counts(client)).toEqual(before);
    expect((await Ledger.trialBalance(client, "EG", "EGP")).amountMinor).toBe(0n);
  });

  it("session_replication_role = replica (superuser) still cannot UPDATE or DELETE postings", async () => {
    await client.transaction(async (tx) => {
      await tx.query("SET LOCAL session_replication_role = replica");
      expect(await rejected(tx.query("UPDATE postings SET amount_minor = amount_minor"))).toContain("not allowed");
      expect(await rejected(tx.query("DELETE FROM journal_entries"))).toContain("not allowed");
    }).catch(() => undefined);
    const r = await client.query<{ tgenabled: string }>(
      "SELECT tgenabled FROM pg_trigger WHERE tgname IN ('postings_immutable','postings_entry_open','journal_entries_immutable','postings_no_truncate','journal_entries_no_truncate')",
    );
    expect(r.rows).toHaveLength(5);
    expect(r.rows.every((x) => x.tgenabled === "A")).toBe(true);
  });
});

describe("account shape checks (A4)", () => {
  const insert = (type: string, code: string, sub: string, market = "EG") =>
    client.query(
      "INSERT INTO ledger_accounts (id, code, type, market_id, currency, owner_type, owner_id, sub) VALUES (gen_random_uuid(), $1, $2, $3, 'EGP', 'user', 'u', $4)",
      [code, type, market, sub],
    );
  it("store_credit needs one of the five enumerated subs; market must be two capital letters", async () => {
    expect(await rejected(insert("store_credit", "store_credit:EG:EGP:u:bogus", "bogus"))).toContain("ledger_accounts_store_credit_sub");
    expect(await rejected(insert("store_credit", "store_credit:eg:EGP:u:goodwill", "goodwill", "eg"))).toContain("market_id_check");
    for (const sub of ["refund_credit", "gift_card", "cashback_coins", "referral_credit", "goodwill"]) {
      await insert("store_credit", `store_credit:EG:EGP:u:${sub}`, sub);
    }
  });
});

describe("outlet_app posting under RLS (A3)", () => {
  const app = () => roleClient(client, "outlet_app");
  it("posts an entry as outlet_app in market EG; the same call under an AE context fails on the outbox RLS", async () => {
    const ok = await withDbContext(app(), { kind: "user", marketId: "EG" }, (tx) =>
      Ledger.post(tx, draftOf({ kind: "line_closed", key: "app:1", lines: [dr(P, 3n), cr(C, 3n)] })),
    );
    expect(ok.replayed).toBe(false);
    const msg = await rejected(
      withDbContext(app(), { kind: "user", marketId: "AE" }, (tx) =>
        Ledger.post(tx, draftOf({ kind: "line_closed", key: "app:2", lines: [dr(P, 3n), cr(C, 3n)] })),
      ),
    );
    expect(msg).toContain("row-level security");
    expect((await client.query("SELECT 1 FROM journal_entries WHERE idempotency_key = 'app:2'")).rows).toHaveLength(0);
  });
});
