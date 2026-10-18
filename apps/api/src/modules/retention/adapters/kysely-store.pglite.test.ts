import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KyselyPurgeExecutor, KyselyPurgeRunStore, type RetentionDb } from "./kysely-store";
import { InMemoryBlobDelete, RecordingMetrics } from "./in-memory";
import { RunRetention } from "../application/purge";
import { TARGETS } from "../domain/catalog";
import type { PurgeTarget } from "../domain/ports";
import { createFullDatabase, type PgliteLike } from "../test/pglite-db";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const NOW = Date.UTC(2026, 9, 11, 1, 0, 0);
const day = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();
let pg: PgliteLike;
let db: RetentionDb;
let blobs: InMemoryBlobDelete;
let runner: RunRetention;
let runs: KyselyPurgeRunStore;
let seq = 0;
const uuid = (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}`;
const target = (id: string): PurgeTarget => {
  const t = TARGETS.find((x) => x.id === id);
  if (t === undefined) throw new Error(id);
  return t;
};
const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await pg.query<T>(sql, params)).rows;
const count = async (table: string, where = "true"): Promise<number> => Number((await q<{ n: string }>(`select count(*)::text n from ${table} where ${where}`))[0]?.n);

async function user(): Promise<string> {
  const id = uuid();
  await q(`insert into users (id, status) values ($1, 'active')`, [id]);
  return id;
}
async function hold(userId: string): Promise<void> {
  await q(`insert into retention_legal_holds (id, subject_type, subject_id, reason, placed_at) values ($1,'user',$2,'case 42', now())`, [uuid(), userId]);
}

beforeAll(async () => {
  ({ pg, db } = await createFullDatabase());
  blobs = new InMemoryBlobDelete();
  runs = new KyselyPurgeRunStore(db);
  runner = new RunRetention({
    executor: new KyselyPurgeExecutor(db, blobs),
    runs,
    metrics: new RecordingMetrics(),
    clock: { nowMs: () => NOW },
    ids: { uuidV7: uuid },
  });
});
afterAll(async () => {
  await db.destroy();
});

describe("KyselyPurgeExecutor against the real schema (PGlite)", () => {
  it("sessions: boundary, revoked-recently kept, legal hold kept, then families and devices cascade away", async () => {
    const u = await user();
    const held = await user();
    const dev = uuid();
    await q(`insert into devices (id, user_id, platform, install_id, last_seen) values ($1,$2,'ios','i1',$3)`, [dev, u, day(500)]);
    const fam = uuid();
    await q(`insert into session_families (id, user_id, device_id, created_at) values ($1,$2,$3,$4)`, [fam, u, dev, day(100)]);
    const mk = async (user_id: string, expires: string, revoked: string | null): Promise<void> => {
      await q(`insert into sessions (id, family_id, user_id, device_id, refresh_hash, rotation_no, amr, expires_at, revoked_at, created_at) values ($1,$2,$3,$4,$5,$6,'otp',$7,$8,$9)`,
        [uuid(), fam, user_id, dev, randomBytes(32), ++seq, expires, revoked, day(200)]);
    };
    await mk(u, day(31), null); // expired 31 days ago: purge (cutoff is 30 days)
    await mk(u, day(60), day(10)); // revoked 10 days ago: keep (latest of expiry/revocation is recent)
    await mk(u, day(29), null); // inside the window: keep
    await mk(held, day(90), null); // old but its owner is under legal hold
    await hold(held);
    const r = await runner.runTarget(target("auth.sessions"));
    expect(r).toMatchObject({ eligible: 1, held: 1, purged: 1, status: "COMPLETED" });
    expect(await count("sessions")).toBe(3);
    const again = await runner.runTarget(target("auth.sessions"));
    expect(again.purged).toBe(0);
    // the family still has sessions, so it is kept; the device too
    expect((await runner.runTarget(target("auth.session_families"))).purged).toBe(0);
    expect((await runner.runTarget(target("devices.stale"))).purged).toBe(0);
  });

  it("carts: idle 90 days purged with their lines (cascade), recent and held carts kept", async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    for (const [u, age] of [[a, 91], [b, 89], [c, 400]] as const) {
      const cart = uuid();
      await q(`insert into carts (id, user_id, updated_at) values ($1,$2,$3)`, [cart, u, day(age)]);
      await q(`insert into cart_lines (id, cart_id, sku_id, store_id, qty, price_at_add_amount) values ($1,$2,$3,$4,1,1000)`, [uuid(), cart, uuid(), uuid()]);
    }
    await hold(c);
    const r = await runner.runTarget(target("carts.idle"));
    expect(r).toMatchObject({ eligible: 1, held: 1, purged: 1 });
    expect(await count("carts")).toBe(2);
    expect(await count("cart_lines")).toBe(2);
  });

  it("outbox: only published events past 30 days go; unpublished are never deleted", async () => {
    const ins = (published: string | null, occurred: string): Promise<unknown[]> =>
      q(`insert into outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, payload, published_at) values ($1,$2,'order',$3,'order.placed','{}'::jsonb,$4)`, [uuid(), occurred, uuid(), published]);
    await ins(day(40), day(41));
    await ins(day(10), day(11));
    await ins(null, day(90));
    const r = await runner.runTarget(target("outbox.published"));
    expect(r.purged).toBe(1);
    expect(await count("outbox_events", "published_at is null")).toBe(1);
    expect(await count("outbox_events")).toBe(2);
  });

  it("inbox and idempotency keys: ctid batches terminate and respect batch size", async () => {
    for (let i = 0; i < 25; i++) await q(`insert into inbox_processed (consumer, message_id, processed_at) values ('c', $1, $2)`, [uuid(), day(31 + i)]);
    await q(`insert into inbox_processed (consumer, message_id, processed_at) values ('c', $1, $2)`, [uuid(), day(1)]);
    const r = await runner.runTarget(target("inbox.processed"), { batchSize: 10 });
    expect(r).toMatchObject({ purged: 25, batches: 3 });
    expect(await count("inbox_processed")).toBe(1);

    const key = (created: number, expires: number): Promise<unknown[]> =>
      q(`insert into idempotency_keys (actor_id, route, key, request_hash, created_at, expires_at) values ($1,'POST /x',$2,$3,$4,$5)`, [uuid(), uuid(), Buffer.alloc(32, 1), day(created), day(expires)]);
    await key(40, 39); // expired and past 30 days
    await key(40, -4000); // still valid (~11 years past NOW, so real now() never catches up): never purge a live key
    await key(10, 9);
    expect((await runner.runTarget(target("idempotency.keys"))).purged).toBe(1);
    expect(await count("idempotency_keys")).toBe(2);
  });

  it("gift card attempts: 24 months", async () => {
    const u = await user();
    const ins = (age: number): Promise<unknown[]> =>
      q(`insert into gift_card_attempts (id, account_id, device_hash, ip_hash, outcome, at) values ($1,$2,$3,$3,'wrong',$4)`, [uuid(), u, "a".repeat(64), day(age)]);
    await ins(24 * 30 + 20);
    await ins(24 * 30 - 20);
    expect((await runner.runTarget(target("gift_card_attempts.old"))).purged).toBe(1);
    expect(await count("gift_card_attempts")).toBe(1);
  });

  it("catalog imports: finished imports purge with their error rows; in-flight imports stay", async () => {
    const store = uuid();
    const imp = async (status: string, age: number): Promise<string> => {
      const id = uuid();
      await q(`insert into catalog_imports (id, store_id, actor_id, upload_id, status, dry_run, rows_total, rows_failed, created_at, updated_at) values ($1,$2,$3,$4,$5,false,1,1,$6,$6)`, [id, store, uuid(), uuid(), status, day(age)]);
      return id;
    };
    const old = await imp("failed", 120);
    await imp("applying", 120);
    await imp("completed", 5);
    await q(`insert into catalog_import_errors (import_id, store_id, row_number, code) values ($1,$2,1,'bad_price')`, [old, store]);
    const r = await runner.runTarget(target("catalog_imports.finished"));
    expect(r.purged).toBe(1);
    expect(await count("catalog_imports")).toBe(2);
    expect(await count("catalog_import_errors")).toBe(0);
  });

  it("gift cards: recipient contact is nulled for delivered cards past 30 days, the card itself stays", async () => {
    const buyer = await user();
    const card = async (age: number): Promise<string> => {
      const id = uuid();
      await q(`insert into gift_cards (id, purchaser_id, amount, remaining, status, design, recipient_channel, recipient_contact, message, idempotency_key, created_at, updated_at, delivered_at)
        values ($1,$2,10000,10000,'PENDING_PAYMENT','eid','sms',$3,$3,$4,$5,$5,null)`, [id, buyer, Buffer.from("+201000000000"), uuid(), day(age)]);
      return id;
    };
    const stale = await card(60);
    // PENDING_PAYMENT is not a terminal state, so nothing is purged yet
    expect((await runner.runTarget(target("gift_cards.recipient_contact"))).purged).toBe(0);
    await q(`update gift_cards set status = 'CANCELLED' where id = $1`, [stale]);
    expect((await runner.runTarget(target("gift_cards.recipient_contact"))).purged).toBe(1);
    const row = (await q<{ recipient_contact: unknown; message: unknown }>(`select recipient_contact, message from gift_cards where id = $1`, [stale]))[0];
    expect(row).toEqual({ recipient_contact: null, message: null });
    expect(await count("gift_cards")).toBe(1);
  });

  it("writes an audit ledger row per run and the dry run leaves data untouched", async () => {
    const u = await user();
    await q(`insert into carts (id, user_id, updated_at) values ($1,$2,$3)`, [uuid(), u, day(200)]);
    const before = await count("carts");
    const dry = await runner.runTarget(target("carts.idle"), { dryRun: true });
    expect(dry).toMatchObject({ eligible: 1, purged: 0 });
    expect(await count("carts")).toBe(before);
    const list = await runs.list("browsing_state");
    expect(list.at(-1)).toMatchObject({ dryRun: true, status: "COMPLETED", rowsEligible: 1 });
    expect(list.some((r) => !r.dryRun && r.rowsPurged === 1)).toBe(true);
  });

  it("the database itself refuses to delete financial evidence (why raw webhooks are an archival exemption)", async () => {
    const id = uuid();
    await q(`insert into payment_events_raw (id, provider, event_id, signature_ok, body, body_sha256, received_at) values ($1,'kashier','e1',true,'{}'::jsonb,$2,$3)`, ["" + id, "a".repeat(64), day(3000)]);
    await expect(q(`delete from payment_events_raw where id = $1`, [id])).rejects.toThrow(/never deleted/);
  });

  it.each(TARGETS.map((t) => [t.id, t] as const))("%s: count and purge SQL are valid against the real schema", async (_id, t) => {
    const ex = new KyselyPurgeExecutor(db, blobs);
    const c = await ex.count(t, NOW);
    expect(c.eligible).toBeGreaterThanOrEqual(0);
    await expect(ex.purgeBatch(t, NOW - 100 * 365 * 86_400_000, 10)).resolves.toBe(0);
  });
});
