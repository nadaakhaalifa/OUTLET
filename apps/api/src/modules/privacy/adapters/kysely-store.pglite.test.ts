import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { lintMigration, migrate, parseMigration, withoutConcurrently, type MigrationFile } from "@outlet/db";
import type { Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { describePrivacyRepositoryContract, U } from "../test/repository-contract";
import { KyselyBreachRepository, KyselyConsentRepository, KyselyPrivacyRequestRepository, type PrivacyDb } from "./kysely-store";

const DIR = fileURLToPath(new URL("../../../../../../packages/db/migrations/", import.meta.url));
const MINE = "0025_privacy_requests.sql";

/** Other waves own 0012..0024; this module needs identity (0006), RLS (0007) and the outbox (0004). */
function migrations(): MigrationFile[] {
  return readdirSync(DIR)
    .filter((n) => n.endsWith(".sql") && (Number(n.slice(0, 4)) <= 11 || n === MINE))
    .sort()
    .map((n) => parseMigration(n, readFileSync(join(DIR, n), "utf8")));
}

const open: Kysely<Record<string, never>>[] = [];
const raws: PGlite[] = [];

async function fresh() {
  const raw = new PGlite();
  await migrate(withoutConcurrently(raw), migrations());
  const db: PrivacyDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  raws.push(raw);
  return {
    raw,
    db,
    requests: new KyselyPrivacyRequestRepository(db),
    breaches: new KyselyBreachRepository(db),
    consents: new KyselyConsentRepository(db),
    ensureUser: async (id: string) => {
      await raw.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    eventTypes: async () => {
      const r = await raw.query<{ event_type: string }>(`select event_type from outbox_events order by occurred_at, id`);
      return r.rows.map((x) => x.event_type);
    },
  };
}

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describePrivacyRepositoryContract("kysely/pglite", fresh);

describe("0025_privacy_requests", () => {
  it("passes the migration linter", () => {
    expect(lintMigration(readFileSync(join(DIR, MINE), "utf8"))).toEqual([]);
  });

  it("rejects shapes the domain would never produce", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const ins = (cols: string, vals: string) =>
      c.raw.query(
        `insert into dsar_requests (id, user_id, ${cols}, requested_at, due_at) values (gen_random_uuid(), '${U(1)}', ${vals}, now(), now())`,
      );
    await expect(ins("kind, status, ready_target_at", `'export', 'cooling', now()`)).rejects.toThrow(/dsar_requests_status_chk/);
    await expect(ins("kind, status", `'export', 'requested'`)).rejects.toThrow(/dsar_requests_shape_chk/);
    await expect(ins("kind, status, cooling_ends_at, ready_target_at", `'delete', 'cooling', now(), now()`)).rejects.toThrow(
      /dsar_requests_shape_chk/,
    );
    await expect(ins("kind, status, ready_target_at", `'export', 'ready', now()`)).rejects.toThrow(
      /dsar_requests_ready_artifact_chk/,
    );
  });

  it("enforces one open export and one open deletion per user at the data layer", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const q = (kind: string, status: string, extra: string) =>
      c.raw.query(
        `insert into dsar_requests (id, user_id, kind, status, requested_at, due_at, ${extra}) values (gen_random_uuid(), '${U(1)}', '${kind}', '${status}', now(), now(), now())`,
      );
    await q("export", "requested", "ready_target_at");
    await expect(q("export", "collecting", "ready_target_at")).rejects.toThrow(/dsar_requests_open_export_uq/);
    await q("delete", "cooling", "cooling_ends_at");
    await expect(q("delete", "on_hold", "cooling_ends_at")).rejects.toThrow(/dsar_requests_open_delete_uq/);
    await q("delete", "cancelled", "cooling_ends_at");
  });

  it("keeps consent_records append-only and blocks breach rows without a DPO decision", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await c.consents.append(
      [
        {
          userId: U(1),
          purpose: "analytics",
          version: 1,
          granted: true,
          method: "settings_toggle",
          at: new Date(1_800_000_000_000).toISOString(),
          ipHash: "ab".repeat(16),
        },
      ],
      [],
    );
    await expect(c.raw.query(`update consent_records set granted = false`)).rejects.toThrow(/append-only/);
    await expect(
      c.raw.query(
        `insert into breach_register (id, detected_at, severity, summary, affected_count, status) values (gen_random_uuid(), now(), 'low', 'x', 0, 'triaged')`,
      ),
    ).rejects.toThrow(/breach_register_decision_chk/);
  });

  it("applies row level security: a shopper sees only their own requests and never the breach register", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await c.ensureUser(U(2));
    await c.raw.exec(
      `insert into dsar_requests (id, user_id, kind, status, requested_at, due_at, ready_target_at) values
         ('${U(11)}', '${U(1)}', 'export', 'requested', now(), now(), now()),
         ('${U(12)}', '${U(2)}', 'export', 'requested', now(), now(), now());
       insert into breach_register (id, detected_at, severity, summary, affected_count, status)
         values ('${U(13)}', now(), 'low', 'x', 0, 'detected');`,
    );
    const as = async <T>(role: string, user: string, fn: (q: PGlite) => Promise<T>): Promise<T> =>
      c.raw.transaction(async (tx) => {
        await tx.exec("SET LOCAL ROLE app_user");
        await tx.query(`select set_config('app.user_id', $1, true), set_config('app.role', $2, true)`, [user, role]);
        return fn(tx as unknown as PGlite);
      });
    const mine = await as("customer", U(1), (q) => q.query<{ id: string }>(`select id::text from dsar_requests`));
    expect(mine.rows.map((r) => r.id)).toEqual([U(11)]);
    const asDpo = await as("dpo", U(3), (q) => q.query(`select id from dsar_requests`));
    expect(asDpo.rows).toHaveLength(2);
    const breaches = await as("customer", U(1), (q) => q.query(`select id from breach_register`));
    expect(breaches.rows).toHaveLength(0);
    await expect(
      as("customer", U(1), (q) =>
        q.query(
          `insert into dsar_requests (id, user_id, kind, status, requested_at, due_at, ready_target_at) values (gen_random_uuid(), '${U(2)}', 'export', 'requested', now(), now(), now())`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
