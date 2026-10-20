import "reflect-metadata";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import request from "supertest";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../../config/env";
import { PROD_ENV, bootProduction, newTestDb, type ProductionTestApp } from "../../../production/test/test-support";
import { createIdGenerator, nodeCsprng } from "../../../platform";
import { RequestDeletion, ProcessDeletions } from "../application/deletion";
import { ProcessExport, RequestExport } from "../application/export";
import { ExporterRegistry } from "../application/exporters";
import { EXPORTER_MANIFEST } from "../application/exporter-manifest";
import { INVENTORY_SNAPSHOT } from "../application/inventory.snapshot";
import { pseudonymFor, planErasure } from "../domain/bridge";
import type { FieldDecryptPort } from "../domain/ports";
import { REQUEST_EXPORT, PROCESS_EXPORT } from "./tokens";
import { InMemoryObjectStore } from "./in-memory";
import { KyselyDeletionBlockers } from "./kysely-blockers";
import { KyselyErasureExecutor, type ErasureReport } from "./kysely-erasure";
import { createKyselyExporters } from "./kysely-exporters";
import { KyselyPrivacyRequestRepository, type PrivacyDb } from "./kysely-store";
import { PrivacyModule, MissingPrivacyPortsError } from "../privacy.module";
import { FakeClock } from "../test/fixtures";

const A = "0192f3a4-5b6c-7d8e-9f01-00000000000a";
const B = "0192f3a4-5b6c-7d8e-9f01-00000000000b";
const C = "0192f3a4-5b6c-7d8e-9f01-00000000000c";
const id = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;

/** AES-256-GCM with AAD, same layout as the modules' dev ciphers (iv | tag | body). */
class TestCipher implements FieldDecryptPort {
  private readonly key = randomBytes(32);
  encrypt(text: string, aad: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(aad, "utf8"));
    const body = Buffer.concat([c.update(Buffer.from(text, "utf8")), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }
  async decrypt(ciphertext: Uint8Array, aad: string): Promise<Uint8Array> {
    const buf = Buffer.from(ciphertext);
    const d = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12), { authTagLength: 16 });
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(buf.subarray(12, 28));
    return new Uint8Array(Buffer.concat([d.update(buf.subarray(28)), d.final()]));
  }
}

/** Reads a stored (method 0) ZIP: name to text. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, string>();
  let o = 0;
  while (o + 30 <= bytes.length && v.getUint32(o, true) === 0x04034b50) {
    const size = v.getUint32(o + 18, true);
    const nameLen = v.getUint16(o + 26, true);
    const extraLen = v.getUint16(o + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(o + 30, o + 30 + nameLen));
    const start = o + 30 + nameLen + extraLen;
    out.set(name, new TextDecoder().decode(bytes.subarray(start, start + size)));
    o = start + size;
  }
  return out;
}

interface World {
  readonly db: PrivacyDb;
  readonly cipher: TestCipher;
  readonly clock: FakeClock;
}

async function seed(db: PrivacyDb, cipher: TestCipher): Promise<void> {
  await sql`select set_config('app.role', 'system', false)`.execute(db);
  // Seeding writes rows whose parents (stores, skus) belong to modules this test does not stand up.
  await sql`set session_replication_role = replica`.execute(db);
  for (const u of [A, B, C]) await sql`insert into users (id, status) values (${u}::uuid, 'active')`.execute(db);
  // Budget (encrypted) for A and B.
  for (const [u, amt] of [[A, "500000"], [B, "999999"]] as const) {
    await sql`insert into budgets (user_id, amount, payday) values (${u}::uuid, ${cipher.encrypt(amt, `budget:${u}:amount`)}, 25)`.execute(db);
  }
  // Size profile (encrypted label) for A and B.
  await sql`insert into size_profiles (id, user_id, kind, label, measurements) values
    (${id(101)}::uuid, ${A}::uuid, 'ME', ${cipher.encrypt("Nada", `size_profile:${A}:${id(101)}:label`)}, ${cipher.encrypt(JSON.stringify({ waist: 70 }), `size_profile:${A}:${id(101)}:measurements`)}),
    (${id(102)}::uuid, ${B}::uuid, 'ME', ${cipher.encrypt("Bob", `size_profile:${B}:${id(102)}:label`)}, null)`.execute(db);
  await sql`insert into carts (user_id) values (${A}::uuid), (${B}::uuid)`.execute(db);
  await sql`insert into notification_preferences (user_id, type, channel, enabled) values (${A}::uuid, 'PROMOTIONS', 'push', true), (${B}::uuid, 'PROMOTIONS', 'push', false)`.execute(db);
  // Closed orders for A and B (financial records that must survive erasure).
  for (const [n, u, status] of [[201, A, "CLOSED"], [202, B, "CLOSED"]] as const) {
    await sql`insert into order_groups (id, user_id, status, payment_method, payment_type, subtotal_amount, shipping_amount, discount_amount, vat_amount, total_amount, idempotency_key, placed_at)
      values (${id(n)}::uuid, ${u}::uuid, 'COMPLETED', 'card', 'prepaid', 10000, 0, 0, 1400, 10000, ${`k${n}`}, now())`.execute(db);
    await sql`insert into seller_orders (id, order_group_id, store_id, user_id, status, payment_type, subtotal_amount, shipping_amount, discount_amount, vat_amount, total_amount, commission_rate_snapshot_bps)
      values (${id(n + 10)}::uuid, ${id(n)}::uuid, ${id(900)}::uuid, ${u}::uuid, ${status}, 'prepaid', 10000, 0, 0, 1400, 10000, 1000)`.execute(db);
    await sql`insert into order_buyer_contacts (seller_order_id, store_id, first_name, phone_relay, governorate_code) values (${id(n + 10)}::uuid, ${id(900)}::uuid, ${u === A ? "Nada" : "Bob"}, '+20100000000', 'CAI')`.execute(db);
  }
  // Store credit (retained financial record).
  for (const [n, u] of [[301, A], [302, B]] as const) {
    await sql`insert into credit_lots (id, user_id, sub_key, granted, remaining, source_key, created_at) values (${id(n)}::uuid, ${u}::uuid, 'refund_credit', 5000, 5000, ${`src${n}`}, now())`.execute(db);
    await sql`insert into credit_transactions (id, user_id, kind, reason, sub_key, amount, dedupe_key, created_at) values (${id(n + 10)}::uuid, ${u}::uuid, 'credit_added', 'refund', 'refund_credit', 5000, ${`tx${n}`}, now())`.execute(db);
  }
  await sql`set session_replication_role = origin`.execute(db);
}

async function count(db: PrivacyDb, table: string, where: string): Promise<number> {
  const r = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(table)} where ${sql.raw(where)}`.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

describe("privacy production adapters over PGlite with the real migrations", () => {
  let w: World;
  beforeAll(async () => {
    const db = (await newTestDb()) as PrivacyDb;
    const cipher = new TestCipher();
    await seed(db, cipher);
    w = { db, cipher, clock: new FakeClock() };
  }, 120_000);
  afterAll(async () => {
    await w.db.destroy();
  });

  describe("deletion blockers", () => {
    it("counts only the subject's open orders, returns, disputes and live store credit", async () => {
      const blockers = new KyselyDeletionBlockers(w.db);
      expect(await blockers.snapshot(A)).toEqual({ openOrders: 0, openReturns: 0, openDisputes: 0, storeCreditMinor: 5000n });
      await sql`set session_replication_role = replica`.execute(w.db);
      await sql`insert into seller_orders (id, order_group_id, store_id, user_id, status, payment_type, subtotal_amount, shipping_amount, discount_amount, vat_amount, total_amount, commission_rate_snapshot_bps)
        values (${id(401)}::uuid, ${id(201)}::uuid, ${id(900)}::uuid, ${C}::uuid, 'SHIPPED', 'prepaid', 1, 0, 0, 0, 1, 1000),
               (${id(402)}::uuid, ${id(201)}::uuid, ${id(900)}::uuid, ${C}::uuid, 'DISPUTED', 'prepaid', 1, 0, 0, 0, 1, 1000)`.execute(w.db);
      await sql`insert into returns (id, user_id, order_line_id, seller_order_id, store_id, qty, reason, resolution, method, shipping_payer, delivered_at, window_ends_at, line_snapshot, idempotency_key, state)
        values (${id(403)}::uuid, ${C}::uuid, ${id(1)}::uuid, ${id(401)}::uuid, ${id(900)}::uuid, 1, 'too_small', 'refund', 'pickup', 'shopper', now(), now(), '{}'::jsonb, 'r1', 'IN_TRANSIT')`.execute(w.db);
      await sql`set session_replication_role = origin`.execute(w.db);
      const c = await blockers.snapshot(C);
      expect(c.openOrders).toBe(1);
      expect(c.openReturns).toBe(1);
      expect(c.openDisputes).toBe(1);
      // Nobody else sees it.
      expect((await blockers.snapshot(B)).openOrders).toBe(0);
      expect(await blockers.snapshot("not-a-uuid")).toEqual({ openOrders: 0, openReturns: 0, openDisputes: 0, storeCreditMinor: 0n });
    });

    it("RequestDeletion is refused while an order is open", async () => {
      const ids = createIdGenerator(w.clock, nodeCsprng);
      const repo = new KyselyPrivacyRequestRepository(w.db);
      const r = await new RequestDeletion(repo, new KyselyDeletionBlockers(w.db), w.clock, ids, 0).execute({ userId: C, acknowledgedForfeiture: true });
      expect(r.kind).toBe("blocked");
      expect(await repo.findLatest(C, "delete")).toBeNull();
    });
  });

  describe("export end to end", () => {
    it("requests, runs the worker, and the ZIP holds each group's rows for the subject only", async () => {
      const ids = createIdGenerator(w.clock, nodeCsprng);
      const repo = new KyselyPrivacyRequestRepository(w.db);
      const store = new InMemoryObjectStore(randomBytes(32));
      const registry = new ExporterRegistry(createKyselyExporters(EXPORTER_MANIFEST, w.db, w.cipher));
      const req = await new RequestExport(repo, w.clock, ids).execute({ userId: A, locale: "en" });
      const done = await new ProcessExport(repo, registry, store, w.clock, ids).execute(req.request.id);
      expect(done.kind).toBe("ready");
      const key = `exports/${A}/${req.request.id}.zip`;
      const bytes = store.bytes(key);
      expect(bytes).toBeDefined();
      const files = unzip(bytes ?? new Uint8Array());
      const json = (t: string): readonly Record<string, unknown>[] => JSON.parse(files.get(`data/${t}.json`) ?? "null") as Record<string, unknown>[];
      // Three modules: budget (decrypted P3), sizing (decrypted P3), orders (indirect), wallet, browse, comms.
      expect(json("budgets")).toHaveLength(1);
      expect(json("budgets")[0]?.amount).toBe("500000");
      expect(json("size_profiles")).toHaveLength(1);
      expect(json("size_profiles")[0]?.label).toBe("Nada");
      expect(json("size_profiles")[0]?.measurements).toEqual({ waist: 70 });
      expect(json("order_groups")).toHaveLength(1);
      expect(json("seller_orders")).toHaveLength(1);
      expect(json("order_buyer_contacts")).toHaveLength(1);
      expect(json("order_buyer_contacts")[0]?.first_name).toBe("Nada");
      expect(json("credit_lots")).toHaveLength(1);
      expect(json("credit_transactions")).toHaveLength(1);
      expect(json("carts")).toHaveLength(1);
      expect(json("notification_preferences")).toHaveLength(1);
      expect(json("users")).toHaveLength(1);
      // No other user's rows, anywhere in the archive, and no raw ciphertext.
      const all = [...files.values()].join("\n");
      expect(all).not.toContain(B);
      expect(all).not.toContain(C);
      expect(all).not.toContain("Bob");
      expect(all).not.toContain("999999");
      expect(all).not.toContain("\\x");
      // Every group is present in the manifest exporters; unserved tables are listed, not faked as empty.
      const manifest = JSON.parse(files.get("manifest.json") ?? "{}") as { exporters: string[]; gaps: string[]; tables: Record<string, number> };
      expect(manifest.exporters).toEqual(EXPORTER_MANIFEST.map((d) => d.key).sort());
      expect(manifest.gaps).toContain("age_attestations");
      expect(manifest.gaps).not.toContain("budgets");
      expect(manifest.tables.budgets).toBe(1);
      expect(files.has("data/age_attestations.json")).toBe(false);
    });

    it("fails closed when the KMS cipher is unavailable instead of exporting ciphertext or empty P3", async () => {
      const ids = createIdGenerator(w.clock, nodeCsprng);
      const repo = new KyselyPrivacyRequestRepository(w.db);
      const store = new InMemoryObjectStore(randomBytes(32));
      const broken: FieldDecryptPort = { decrypt: () => Promise.reject(new Error("kms down")) };
      const registry = new ExporterRegistry(createKyselyExporters(EXPORTER_MANIFEST, w.db, broken));
      const req = await new RequestExport(repo, w.clock, ids).execute({ userId: B, locale: "ar" });
      const done = await new ProcessExport(repo, registry, store, w.clock, ids).execute(req.request.id);
      expect(done.kind).toBe("retry");
      expect(store.size).toBe(0);
    });
  });

  describe("erasure", () => {
    it("pseudonymises, deletes personal-only rows, retains financial rows, and a replay is a no-op", async () => {
      const ids = createIdGenerator(w.clock, nodeCsprng);
      const repo = new KyselyPrivacyRequestRepository(w.db);
      const store = new InMemoryObjectStore(randomBytes(32));
      const reports: ErasureReport[] = [];
      const executor = new KyselyErasureExecutor(w.db, { objectStore: store, inventory: INVENTORY_SNAPSHOT, onReport: (r) => reports.push(r) });
      const blockers = new KyselyDeletionBlockers(w.db);
      const hasher = (s: string): string => `h${s.length}`;
      const worker = new ProcessDeletions(repo, blockers, executor, () => INVENTORY_SNAPSHOT, hasher, w.clock, ids);
      // An export artifact exists for A and must be removed by the erasure.
      const exportReq = await new RequestExport(repo, w.clock, ids).execute({ userId: A, locale: "en" });
      await store.put(`exports/${A}/${exportReq.request.id}.zip`, new Uint8Array([1]), "application/zip");

      const requested = await new RequestDeletion(repo, blockers, w.clock, ids, 0).execute({ userId: A, acknowledgedForfeiture: true });
      expect(requested.kind).toBe("created");
      if (requested.kind !== "created") return;
      const before = {
        orders: await count(w.db, "order_groups", `user_id = '${A}'`),
        lots: await count(w.db, "credit_lots", `user_id = '${A}'`),
        tx: await count(w.db, "credit_transactions", `user_id = '${A}'`),
      };
      expect(before).toEqual({ orders: 1, lots: 1, tx: 1 });

      const r1 = await worker.execute(requested.request.id);
      expect(r1.kind).toBe("completed");

      // Personal-only rows are gone.
      expect(await count(w.db, "carts", `user_id = '${A}'`)).toBe(0);
      expect(await count(w.db, "budgets", `user_id = '${A}'`)).toBe(0);
      expect(await count(w.db, "size_profiles", `user_id = '${A}'`)).toBe(0);
      expect(await count(w.db, "notification_preferences", `user_id = '${A}'`)).toBe(0);
      // Financial and tax records inside retention survive, untouched.
      expect(await count(w.db, "order_groups", `user_id = '${A}'`)).toBe(1);
      expect(await count(w.db, "seller_orders", `user_id = '${A}'`)).toBe(1);
      expect(await count(w.db, "credit_lots", `user_id = '${A}'`)).toBe(1);
      expect(await count(w.db, "credit_transactions", `user_id = '${A}'`)).toBe(1);
      // The row stays (order record inside retention) but the buyer's name is scrubbed; the account is a tombstone.
      const contact = await sql<{ first_name: string | null }>`select first_name from order_buyer_contacts where seller_order_id = ${id(211)}::uuid`.execute(w.db);
      expect(contact.rows).toHaveLength(1);
      expect(contact.rows[0]?.first_name).toBeNull();
      const user = await sql<{ status: string; deleted: boolean }>`select status, deleted_at is not null as deleted from users where id = ${A}::uuid`.execute(w.db);
      expect(user.rows[0]).toEqual({ status: "deleted", deleted: true });
      // The archive is gone and the export request is closed.
      expect(store.has(`exports/${A}/${exportReq.request.id}.zip`)).toBe(false);
      // Other subjects are untouched.
      expect(await count(w.db, "carts", `user_id = '${B}'`)).toBe(1);
      expect(await count(w.db, "size_profiles", `user_id = '${B}'`)).toBe(1);
      const bContact = await sql<{ first_name: string | null }>`select first_name from order_buyer_contacts where seller_order_id = ${id(212)}::uuid`.execute(w.db);
      expect(bContact.rows[0]?.first_name).toBe("Bob");
      expect((await sql<{ status: string }>`select status from users where id = ${B}::uuid`.execute(w.db)).rows[0]?.status).toBe("active");

      // Honest report: counts and table names only.
      const report = reports[0];
      expect(report?.deleted.carts).toBe(1);
      expect(report?.scrubbed.order_buyer_contacts).toBe(1);
      expect(JSON.stringify(report)).not.toContain(A);

      // Replay: the worker skips a completed request, and re-running the executor changes nothing.
      expect((await worker.execute(requested.request.id)).kind).toBe("skipped");
      await executor.execute({ userId: A, pseudonym: pseudonymFor(A, hasher), plan: planOf(), artifactKeys: [] });
      expect(await count(w.db, "order_groups", `user_id = '${A}'`)).toBe(1);
      expect(await count(w.db, "credit_lots", `user_id = '${A}'`)).toBe(1);
      expect(reports.at(-1)?.deleted.carts ?? 0).toBe(0);
    });

    it("an unconfigured object store never blocks erasure (no archive can exist)", async () => {
      const ex = new KyselyErasureExecutor(w.db, { objectStore: { configured: false, put: () => Promise.reject(new Error("x")), delete: () => Promise.reject(new Error("must not be called")), signGetUrl: () => Promise.reject(new Error("x")) }, inventory: INVENTORY_SNAPSHOT });
      await expect(ex.execute({ userId: B, pseudonym: "del_x", plan: { tables: [], counts: { erase: 0, pseudonymise: 0, retain_by_law: 0, none: 0 } }, artifactKeys: ["exports/b/x.zip"] })).resolves.toBeUndefined();
    });

    it("refuses a non-uuid subject", async () => {
      const ex = new KyselyErasureExecutor(w.db, { objectStore: new InMemoryObjectStore(randomBytes(32)), inventory: INVENTORY_SNAPSHOT });
      await expect(ex.execute({ userId: "x'; drop table users;--", pseudonym: "del_x", plan: planOf() })).rejects.toThrow(/uuid/);
    });
  });
});

function planOf(): ReturnType<typeof planErasure> {
  return planErasure(INVENTORY_SNAPSHOT);
}

describe("production composition of privacy and price-integrity", () => {
  let t: ProductionTestApp;
  beforeAll(async () => {
    t = await bootProduction();
  }, 120_000);
  afterAll(async () => {
    await t.app.close();
  });

  it("forRoot in production names every missing port instead of building fakes", () => {
    const config = loadConfig({ ...PROD_ENV });
    expect(() => PrivacyModule.forRoot(config)).toThrow(MissingPrivacyPortsError);
    try {
      PrivacyModule.forRoot(config);
    } catch (e) {
      expect((e as MissingPrivacyPortsError).missing).toEqual(
        expect.arrayContaining(["consentRepository", "blockers", "objectStore", "exporters", "erasureExecutor", "inventory", "pseudonymKey"]),
      );
    }
  });

  it("is reported composed, with the unconfigured object store and KMS visible in /v1/ready", async () => {
    const r = await request(t.app.getHttpServer()).get("/v1/ready");
    expect(r.body.modules.blocked).not.toContain("privacy");
    expect(r.body.modules.blocked).not.toContain("price-integrity");
    expect(r.body.providers["object.store"]).toBe("unconfigured");
    expect(r.body.providers["kms.envelope"]).toBe("unconfigured");
  });

  it("exports wait in `requested` (not failed) until an object store is configured", async () => {
    await sql`select set_config('app.role', 'system', false)`.execute(t.db);
    await sql`insert into users (id, status) values (${A}::uuid, 'active')`.execute(t.db);
    const requestExport = t.app.get<RequestExport>(REQUEST_EXPORT, { strict: false });
    const processExport = t.app.get<ProcessExport>(PROCESS_EXPORT, { strict: false });
    const req = await requestExport.execute({ userId: A, locale: "en" });
    for (let i = 0; i < 5; i += 1) expect((await processExport.execute(req.request.id)).kind).toBe("skipped");
    const row = await sql<{ status: string; attempts: number }>`select status, attempts from dsar_requests where id = ${req.request.id}::uuid`.execute(t.db);
    expect(row.rows[0]).toEqual({ status: "requested", attempts: 0 });
  });
});

