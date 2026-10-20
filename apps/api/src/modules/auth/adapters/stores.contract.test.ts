import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createTestDatabaseUpTo } from "@outlet/db";
import { createPgDatabase, createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { LocalKeyFieldCipher } from "./field-cipher";
import {
  InMemoryOtpChallengeRepository,
  InMemoryOtpSendLog,
  InMemorySessionRepository,
  InMemoryUserDirectory,
} from "./in-memory";
import {
  InMemoryAgeGateStore,
  InMemoryNonceStore,
  InMemoryPasskeyChallengeStore,
  InMemoryPasskeyCredentialRepository,
} from "./in-memory-identity";
import {
  KyselyAgeGateStore,
  KyselyNonceStore,
  KyselyOtpChallengeRepository,
  KyselyOtpSendLog,
  KyselyPasskeyChallengeStore,
  KyselyPasskeyCredentialRepository,
  KyselySessionRepository,
  KyselyUserDirectory,
  type AuthDb,
} from "./kysely-stores";
import { describeAuthStoresContract, type StoresFixture } from "../test/stores-contract";
import { sql } from "kysely";
import { AccountUnavailableError } from "../domain/ports";

describeAuthStoresContract("in-memory", async (): Promise<StoresFixture> => ({
  users: new InMemoryUserDirectory(),
  sessions: new InMemorySessionRepository(),
  challenges: new InMemoryOtpChallengeRepository(),
  sendLog: new InMemoryOtpSendLog(),
  ageGate: new InMemoryAgeGateStore(),
  nonces: new InMemoryNonceStore(),
  passkeyChallenges: new InMemoryPasskeyChallengeStore(),
  passkeyCredentials: new InMemoryPasskeyCredentialRepository(),
}));

const cipher = new LocalKeyFieldCipher(new Uint8Array(randomBytes(32)));
const makeKysely = (db: AuthDb) => async (): Promise<StoresFixture> => ({
  users: new KyselyUserDirectory(db, cipher),
  sessions: new KyselySessionRepository(db),
  challenges: new KyselyOtpChallengeRepository(db, cipher),
  sendLog: new KyselyOtpSendLog(db, cipher),
  ageGate: new KyselyAgeGateStore(db),
  nonces: new KyselyNonceStore(db),
  passkeyChallenges: new KyselyPasskeyChallengeStore(db),
  passkeyCredentials: new KyselyPasskeyCredentialRepository(db),
});

// One migrated database per file. The first run uses the migration owner (RLS bypassed); the second
// switches the session to the `app_user` role, so grants and RLS policies of 0047 are exercised too.
const dbPromise = createTestDatabaseUpTo(9999).then((raw) => ({ raw, db: createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance) }));
afterAll(async () => (await dbPromise).db.destroy());

describeAuthStoresContract("kysely/pglite (owner)", async () => makeKysely((await dbPromise).db)());

describe("kysely/pglite findByPhone and suspended accounts", () => {
  it("findByPhone ignores a suspended account; create mode answers a typed AccountUnavailableError and creates nothing", async () => {
    const { raw, db } = await dbPromise;
    const users = new KyselyUserDirectory(db, cipher);
    const p = `+2010${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const u = await users.findOrCreateByPhone({ phoneE164: p, language: "ar", newId: randomUUID(), nowMs: 1_800_000_000_000 });
    await raw.query(`update users set status = 'suspended' where id = $1`, [u.id]);
    expect(await users.findByPhone(p)).toBeNull();
    const before = (await raw.query(`select count(*)::int as n from users`)).rows[0] as { n: number };
    await expect(users.findOrCreateByPhone({ phoneE164: p, language: "ar", newId: randomUUID(), nowMs: 1_800_000_000_001 })).rejects.toBeInstanceOf(AccountUnavailableError);
    const after = (await raw.query(`select count(*)::int as n from users`)).rows[0] as { n: number };
    expect(after.n).toBe(before.n);
    await raw.query(`update users set status = 'active' where id = $1`, [u.id]);
  });

  it("findByIdentity ignores a suspended account; find-or-create by identity answers AccountUnavailableError and creates nothing", async () => {
    const { raw, db } = await dbPromise;
    const users = new KyselyUserDirectory(db, cipher);
    const subject = `sub-${randomUUID()}`;
    const u = await users.findOrCreateByIdentity({ provider: "google", subject, email: null, language: "ar", newId: randomUUID(), nowMs: 1_800_000_000_000 });
    await raw.query(`update users set status = 'suspended' where id = $1`, [u.id]);
    expect(await users.findByIdentity("google", subject)).toBeNull();
    const before = (await raw.query(`select count(*)::int as n from users`)).rows[0] as { n: number };
    await expect(
      users.findOrCreateByIdentity({ provider: "google", subject, email: null, language: "ar", newId: randomUUID(), nowMs: 1_800_000_000_001 }),
    ).rejects.toBeInstanceOf(AccountUnavailableError);
    const after = (await raw.query(`select count(*)::int as n from users`)).rows[0] as { n: number };
    expect(after.n).toBe(before.n);
    await raw.query(`update users set status = 'active' where id = $1`, [u.id]);
  });
});

describe("kysely/pglite under the app_user role (RLS applies)", () => {
  it("the whole contract holds with RLS enforced", async () => {
    const { raw, db } = await dbPromise;
    await raw.exec("SET ROLE app_user");
    try {
      const f = await makeKysely(db)();
      const u = await f.users.findOrCreateByPhone({ phoneE164: "+201000000001", language: "ar", newId: "0190a000-0000-7000-8000-0000000000a1", nowMs: 1 });
      expect(u.phoneE164).toBe("+201000000001");
      // Without elevating to `system` the same role sees nothing: deny by default.
      const direct = await sql`select count(*)::int as n from users`.execute(db);
      expect((direct.rows[0] as { n: number }).n).toBe(0);
      const c = await f.passkeyChallenges.take("0190a000-0000-7000-8000-0000000000a2", 1);
      expect(c).toBeNull();
    } finally {
      await raw.exec("RESET ROLE");
    }
  });
});

describeAuthStoresContract("kysely/pglite (app_user, RLS)", async () => {
  const { raw, db } = await dbPromise;
  await raw.exec("SET ROLE app_user");
  return makeKysely(db)();
});

// Opt-in: the same contract against a real Postgres (row locks and RLS under a LOGIN role that is a
// member of app_user), e.g. AUTH_PG_URL=postgres://outlet_app@127.0.0.1:5433/outlet. Skipped in CI
// runs without a database.
const pgUrl = process.env["AUTH_PG_URL"];
if (pgUrl !== undefined && pgUrl !== "") {
  const real = createPgDatabase<Record<string, never>>({ connectionString: pgUrl, max: 8, applicationName: "auth-contract" });
  afterAll(async () => real.destroy());
  describeAuthStoresContract("kysely/real postgres (app role, RLS)", async () => makeKysely(real)());
}
