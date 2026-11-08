import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { AesGcmFieldCipher, Hasher } from "@outlet/auth-core";
import { applyMigrations, brandClient } from "@outlet/db";
import type { Queryable, SqlClient } from "@outlet/db";
import { bootstrapTestRoles, roleClient } from "@outlet/db/testing";
import type { Principal } from "@outlet/policy";
import { SellerOnboardingService, StoreMembershipService } from "../src/index.js";
import type { SellerAccountsDeps } from "../src/index.js";
import { FakeKycCheck, FakeStrongAuth } from "../src/testing.js";

process.env.OUTLET_LOCAL_CIPHER = "1";

const DIR = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

/** Like createTestClient but tolerant of numbering gaps (0014 belongs to another package in flight). */
const makeDb = async (): Promise<{ client: SqlClient; close: () => Promise<void> }> => {
  const db = new PGlite();
  await bootstrapTestRoles(db);
  const files = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();
  await applyMigrations(db, await Promise.all(files.map(async (f) => ({ name: f.replace(/\.sql$/u, ""), sql: await readFile(`${DIR}/${f}`, "utf8") }))));
  const wrap = (q: { query: PGlite["query"] }): Queryable => ({
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
    query: async <R extends object>(sql: string, params?: readonly unknown[]) => ({ rows: (await q.query<R>(sql, params ? [...params] : [])).rows }),
  });
  const client: SqlClient = {
    ...wrap(db),
    transaction: <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction((t) => fn(wrap(t as unknown as { query: PGlite["query"] }))),
  };
  return { client, close: () => db.close() };
};

export const DOB_21 = "1990-05-05";
export const DOB_19 = "2011-06-01";
export const MARKET = "EG";
// Valid Egyptian IBAN (mod-97 checked): EG + 2 check digits + 25 digits.
export const IBAN = "EG380019000500000000263180002";

export interface World {
  readonly raw: SqlClient;
  readonly deps: SellerAccountsDeps;
  readonly hasher: Hasher;
  readonly cipher: AesGcmFieldCipher;
  readonly check: FakeKycCheck;
  readonly onboarding: SellerOnboardingService;
  readonly members: StoreMembershipService;
  readonly app: ReturnType<typeof roleClient<"outlet_app">>;
  readonly auth: ReturnType<typeof roleClient<"outlet_auth">>;
  readonly phone: Map<string, string>;
  readonly user: (opts?: { dob?: string; phone?: string }) => Promise<string>;
  readonly media: (userId: string) => Promise<string>;
  readonly approvedSeller: (applicant: string) => Promise<{ sellerId: string; caseId: string; storeId: string }>;
  readonly close: () => Promise<void>;
}

let phoneSeq = 1000;

export const admin = (roles: readonly string[] = ["ops"]): Principal => ({ kind: "admin", userId: randomUUID(), marketId: MARKET, roles: [...roles], scopes: [] });
export const staff = (userId: string, storeIds: readonly string[], roles: readonly string[] = ["owner"]): Principal => ({ kind: "seller_staff", userId, marketId: MARKET, storeIds: [...storeIds], roles: [...roles], scopes: [] });

export const buildWorld = async (): Promise<World> => {
  const { client: raw, close } = await makeDb();
  const hasher = new Hasher(Buffer.alloc(32, 7));
  const cipher = new AesGcmFieldCipher(Buffer.alloc(32, 9));
  const app = roleClient(raw, "outlet_app");
  const auth = roleClient(raw, "outlet_auth");
  const worker = roleClient(raw, "outlet_worker");
  let tick = Date.parse("2030-01-01T00:00:00.000Z");
  const deps: SellerAccountsDeps = { app, auth, worker, marketId: MARKET, cipher, hasher, now: () => new Date((tick += 1000)) };
  const check = new FakeKycCheck();
  const phone = new Map<string, string>();
  const user = async (opts: { dob?: string; phone?: string } = {}): Promise<string> => {
    const id = randomUUID();
    const p = opts.phone ?? `+2010${String(phoneSeq++).padStart(8, "0")}`;
    phone.set(id, p);
    await raw.query(
      `INSERT INTO users (id, market_id, status, phone_ct, phone_bidx, dob_ct, age_band, locale, created_at, updated_at)
       VALUES ($1,$2,'active',$3,$4,$5,'21_plus','ar-EG',now(),now())`,
      [id, MARKET, await cipher.encrypt(p, "users.phone_ct"), hasher.hmac("phone", `${MARKET}:${p}`), await cipher.encrypt(opts.dob ?? DOB_21, "users.dob_ct")],
    );
    return id;
  };
  const media = async (userId: string): Promise<string> => {
    const id = randomUUID();
    await raw.query(
      `INSERT INTO media_assets (id, market_id, store_id, kind, status, sha256, mime, bytes, storage_key, created_by) VALUES ($1,$2,NULL,'document','ready',$3,'application/pdf',100,$4,$5)`,
      [id, MARKET, "a".repeat(64), `kyc/${id}`, userId],
    );
    return id;
  };
  const onboarding = new SellerOnboardingService(deps, check);
  const members = new StoreMembershipService(deps, new FakeStrongAuth());

  const approvedSeller = async (applicant: string): Promise<{ sellerId: string; caseId: string; storeId: string }> => {
    const n = String(phoneSeq++);
    const { sellerId, caseId } = await onboarding.createDraft(applicant, {
      legal_type: "company", legal_name_ar: "شركة النور", commercial_register_no: `CR-${n}`, tax_card_no: `TX-${n}`, governorate_code: "CAI", governorate_name_ar: "القاهرة",
    });
    for (const kind of ["commercial_register", "tax_card", "signatory_national_id"] as const) await onboarding.addDocument(applicant, sellerId, { kind, mediaAssetId: await media(applicant) });
    await onboarding.setBankAccount(applicant, sellerId, { iban: IBAN, accountName: "شركة النور" });
    await onboarding.submit(applicant, sellerId);
    await onboarding.decide(admin(), caseId, { decision: "approve" });
    const storeId = randomUUID();
    await raw.query(`INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country, status) VALUES ($1,$2,$3,$4,'متجر','local','EG','ACTIVE')`, [storeId, sellerId, MARKET, `s-${n}`]);
    return { sellerId, caseId, storeId };
  };
  return { raw, deps, hasher, cipher, check, onboarding, members, app, auth, phone, user, media, approvedSeller, close };
};

/**
 * Counts business statements (context binding excluded) issued through the outlet_auth client while fn runs.
 * Rebuilds the service on a counting client, so it measures exactly what membershipsFor sends.
 */
export const countQueries = async <T>(w: World, fn: (svc: StoreMembershipService) => Promise<T>): Promise<{ result: T; count: number; statements: string[] }> => {
  const statements: string[] = [];
  const wrap = (q: Queryable): Queryable => ({
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
    query: <R extends object>(sql: string, params?: readonly unknown[]) => {
      if (!sql.startsWith("SELECT set_config(")) statements.push(sql);
      return q.query<R>(sql, params);
    },
  });
  const auth = brandClient<"outlet_auth">({
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
    query: <R extends object>(sql: string, params?: readonly unknown[]) => wrap(w.auth).query<R>(sql, params),
    transaction: <T2>(f: (tx: Queryable) => Promise<T2>) => w.auth.transaction((tx) => f(wrap(tx))),
  });
  const svc = new StoreMembershipService({ ...w.deps, auth }, new FakeStrongAuth());
  const result = await fn(svc);
  return { result, count: statements.length, statements };
};
