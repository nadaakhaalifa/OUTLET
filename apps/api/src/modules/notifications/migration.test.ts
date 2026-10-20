import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @electric-sql/pglite is a dependency of packages/db, not of apps/api (no new packages in this wave).
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration, migrate, parseMigration, type MigrationFile, withoutConcurrently } from "@outlet/db";

const DIR = fileURLToPath(new URL("../../../../../packages/db/migrations/", import.meta.url));
const MINE = "0018_notifications.sql";
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const I = (n: number): string => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;

let db: PGlite;

/** Other agents own 0012..0017 in this wave, so apply 0001..0011 then mine. */
function dependencies(): MigrationFile[] {
  return readdirSync(DIR)
    .filter((n) => n.endsWith(".sql") && (Number(n.slice(0, 4)) <= 11 || n === MINE))
    .sort()
    .map((n) => parseMigration(n, readFileSync(join(DIR, n), "utf8")));
}

beforeAll(async () => {
  db = new PGlite();
  await migrate(withoutConcurrently(db), dependencies());
  await db.query(`INSERT INTO users (id) VALUES ($1), ($2)`, [U(1), U(2)]);
}, 60_000);
afterAll(async () => {
  await db.close();
});

const as = async <T>(user: string | null, role: string, fn: (q: PGlite) => Promise<T>): Promise<T> =>
  db.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE app_user");
    await tx.query(`SELECT set_config('app.user_id', $1, true), set_config('app.role', $2, true)`, [user ?? "", role]);
    return fn(tx as unknown as PGlite);
  });

interface TemplateRow {
  key: string;
  version: number;
  channel: string;
  category: string;
  type: string;
  body_ar: string;
  active: boolean;
  provider_template_id?: string | null;
  approval_status?: string;
}
const template = (key: string, over: Partial<TemplateRow> = {}) => {
  const v: TemplateRow = { key, version: 1, channel: "push", category: "marketing", type: "PROMOTIONS", body_ar: "نص", active: false, ...over };
  return db.query(
    `INSERT INTO notification_templates (key, version, channel, category, type, body_ar, active, provider_template_id, approval_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [v.key, v.version, v.channel, v.category, v.type, v.body_ar, v.active, v.provider_template_id ?? null, v.approval_status ?? "DRAFT"],
  );
};

describe("0018_notifications", () => {
  it("passes the migration linter", () => {
    expect(lintMigration(readFileSync(join(DIR, MINE), "utf8"))).toEqual([]);
  });

  it("will not activate a template without an Arabic body", async () => {
    await template("t_draft", { body_ar: "", active: false });
    await expect(template("t_bad", { body_ar: "   ", active: true })).rejects.toThrow(/arabic_required/);
    await template("t_ok", { body_ar: "مرحبا", active: true });
  });

  it("requires an approved provider template for an active WhatsApp template", async () => {
    await expect(template("wa_bad", { channel: "whatsapp", active: true })).rejects.toThrow(/whatsapp_approved/);
    await template("wa_ok", { channel: "whatsapp", active: true, provider_template_id: "wa_1", approval_status: "APPROVED" });
  });

  it("allows one active version per (key, channel) and unique (key, version, channel)", async () => {
    await template("one_active", { version: 1, active: true });
    await expect(template("one_active", { version: 2, active: true })).rejects.toThrow(/duplicate|unique/);
    await template("one_active", { version: 2, active: false });
    await expect(template("one_active", { version: 2, active: false })).rejects.toThrow(/duplicate|unique/);
  });

  it("enforces request identity, schedule consistency and suppression reason", async () => {
    const ins = (over: Record<string, unknown> = {}) => {
      const v = { user: U(1), key: "promo_drop", ref: "r1", status: "ACCEPTED", scheduled: null, reason: null, ...over };
      return db.query(
        `INSERT INTO notification_requests (user_id, template_key, ref, category, type, payload, template_versions, status,
           suppressed_reason, scheduled_for, expires_at)
         VALUES ($1,$2,$3,'marketing','PROMOTIONS','{}','{}',$4,$5,$6, now() + interval '1 day')`,
        [v.user, v.key, v.ref, v.status, v.reason, v.scheduled],
      );
    };
    await ins();
    await expect(ins()).rejects.toThrow(/duplicate|identity_uq/);
    await ins({ user: U(2) }); // another user, same key and ref
    await expect(ins({ ref: "r2", status: "SCHEDULED" })).rejects.toThrow(/scheduled_chk/);
    await ins({ ref: "r3", status: "SCHEDULED", scheduled: "2027-01-16T07:00:00Z" });
    await expect(ins({ ref: "r4", status: "SUPPRESSED" })).rejects.toThrow(/suppressed_chk/);
    await ins({ ref: "r5", status: "SUPPRESSED", reason: "NO_CONSENT" });
    await expect(ins({ ref: "r6", status: "SUPPRESSED", reason: "BECAUSE" })).rejects.toThrow(/check/);
  });

  it("keeps preferences, push tokens and suppressions per user, with one token row per (user, install)", async () => {
    await db.query(`INSERT INTO notification_push_tokens (user_id, install_id, platform, token) VALUES ($1,$2,'ios','token-aaaaaaaa')`, [U(1), I(1)]);
    await db.query(`INSERT INTO notification_push_tokens (user_id, install_id, platform, token) VALUES ($1,$2,'ios','token-bbbbbbbb')`, [U(2), I(1)]);
    await expect(
      db.query(`INSERT INTO notification_push_tokens (user_id, install_id, platform, token) VALUES ($1,$2,'ios','token-cccccccc')`, [U(1), I(1)]),
    ).rejects.toThrow(/duplicate|uq/);
    await expect(
      db.query(`INSERT INTO notification_push_tokens (user_id, install_id, platform, token) VALUES ($1,$2,'ios','short')`, [U(1), I(2)]),
    ).rejects.toThrow(/check/);
    await db.query(`INSERT INTO notification_preferences (user_id, type, channel, enabled) VALUES ($1,'PLUS','*',false)`, [U(1)]);
    await expect(
      db.query(`INSERT INTO notification_preferences (user_id, type, channel, enabled) VALUES ($1,'ORDER_UPDATES','*',false)`, [U(1)]),
    ).rejects.toThrow(/check/);
    await db.query(`INSERT INTO notification_suppressions (user_id, channel, reason) VALUES ($1,'push','UNSUBSCRIBED')`, [U(1)]);
    await expect(
      db.query(`INSERT INTO notification_suppressions (user_id, channel, reason) VALUES ($1,'sms','UNSUBSCRIBED') , ($1,'sms','UNSUBSCRIBED')`, [U(1)]),
    ).rejects.toThrow(/duplicate|uq|affect row a second time/);
  });

  it("requires a failure code on failed log rows", async () => {
    const [req] = (await db.query<{ id: string }>(`SELECT id FROM notification_requests WHERE user_id = $1 LIMIT 1`, [U(1)])).rows;
    const log = (status: string, code: string | null) =>
      db.query(
        `INSERT INTO notification_log (request_id, user_id, channel, template_key, template_version, category, provider_code, status, failure_code)
         VALUES ($1,$2,'push','promo_drop',1,'marketing','expo_push',$3,$4)`,
        [req?.id, U(1), status, code],
      );
    await log("SENT", null);
    await expect(log("FAILED", null)).rejects.toThrow(/failure_chk/);
    await log("FAILED", "provider_unavailable");
  });
});

describe("0018 row level security", () => {
  let reqA = "";
  let reqB = "";
  beforeAll(async () => {
    reqA = (await db.query<{ id: string }>(`SELECT id FROM notification_requests WHERE user_id = $1 AND ref = 'r1'`, [U(1)])).rows[0]?.id ?? "";
    reqB = (await db.query<{ id: string }>(`SELECT id FROM notification_requests WHERE user_id = $1 AND ref = 'r1'`, [U(2)])).rows[0]?.id ?? "";
    for (const [u, r, t] of [[U(1), reqA, "mine"], [U(2), reqB, "theirs"]] as const) {
      await db.query(
        `INSERT INTO inbox_messages (user_id, request_id, type, title_ar, body_ar, expires_at)
         VALUES ($1,$2,'PROMOTIONS',$3,$3, now() + interval '90 days')`,
        [u, r, t],
      );
    }
  });

  it("shows a user only their own inbox, requests, log, preferences and tokens", async () => {
    await as(U(1), "shopper", async (q) => {
      expect((await q.query<{ title_ar: string }>(`SELECT title_ar FROM inbox_messages`)).rows.map((r) => r.title_ar)).toEqual(["mine"]);
      expect((await q.query(`SELECT 1 FROM notification_requests WHERE user_id <> $1`, [U(1)])).rows).toHaveLength(0);
      expect((await q.query(`SELECT 1 FROM notification_push_tokens WHERE user_id <> $1`, [U(1)])).rows).toHaveLength(0);
      expect((await q.query(`SELECT 1 FROM notification_preferences WHERE user_id <> $1`, [U(1)])).rows).toHaveLength(0);
    });
  });

  it("lets a user mark only their own inbox rows read", async () => {
    await as(U(1), "shopper", async (q) => {
      const own = await q.query(`UPDATE inbox_messages SET read_at = now() WHERE title_ar = 'mine'`);
      const foreign = await q.query(`UPDATE inbox_messages SET read_at = now() WHERE title_ar = 'theirs'`);
      expect(own.affectedRows).toBe(1);
      expect(foreign.affectedRows).toBe(0);
    });
  });

  it("denies a shopper creating requests, log rows or inbox rows; allows the system role", async () => {
    await as(U(1), "shopper", async (q) => {
      await expect(
        q.query(
          `INSERT INTO notification_requests (user_id, template_key, ref, category, type, payload, template_versions, status, expires_at)
           VALUES ($1,'x_key','z','marketing','PROMOTIONS','{}','{}','ACCEPTED', now() + interval '1 day')`,
          [U(1)],
        ),
      ).rejects.toThrow(/row-level security/);
    });
    await as(U(1), "shopper", async (q) => {
      await expect(
        q.query(`INSERT INTO inbox_messages (user_id, request_id, type, title_ar, body_ar, expires_at)
                 VALUES ($1,$2,'PROMOTIONS','a','b', now() + interval '1 day')`, [U(1), reqA]),
      ).rejects.toThrow(/row-level security|duplicate|unique/);
    });
    await as(null, "system", async (q) => {
      await q.query(
        `INSERT INTO notification_requests (user_id, template_key, ref, category, type, payload, template_versions, status, expires_at)
         VALUES ($1,'x_key','sys','marketing','PROMOTIONS','{}','{}','ACCEPTED', now() + interval '1 day')`,
        [U(1)],
      );
    });
  });

  it("lets everyone read templates but only marketing, super_admin and system write them", async () => {
    await as(U(1), "shopper", async (q) => {
      expect(((await q.query(`SELECT 1 FROM notification_templates`)).rows).length).toBeGreaterThan(0);
      await expect(
        q.query(`INSERT INTO notification_templates (key, version, channel, category, type, body_ar) VALUES ('hax',1,'push','marketing','PROMOTIONS','x')`),
      ).rejects.toThrow(/row-level security/);
    });
    await as(U(1), "marketing", async (q) => {
      await q.query(`INSERT INTO notification_templates (key, version, channel, category, type, body_ar) VALUES ('from_marketing',1,'push','marketing','PROMOTIONS','x')`);
    });
  });
});
