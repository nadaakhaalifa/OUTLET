import { randomBytes, randomUUID } from "node:crypto";
import type { SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgPasskeyStore } from "../src/modules/auth/index.js";
import type { PasskeyCredentialRecord } from "../src/modules/auth/index.js";

let admin: SqlClient;
let close: () => Promise<void>;
let store: PgPasskeyStore;

beforeAll(async () => {
  ({ client: admin, close } = await createTestClient());
  store = new PgPasskeyStore(roleClient(admin, "outlet_auth"));
});
afterAll(async () => {
  await close();
});

const user = async (): Promise<string> => {
  const id = randomUUID();
  await admin.query("INSERT INTO users (id, market_id, status, created_at, updated_at) VALUES ($1, 'EG', 'active', now(), now())", [id]);
  return id;
};
const cred = (userId: string, o: Partial<PasskeyCredentialRecord> = {}): PasskeyCredentialRecord => ({
  id: randomUUID(), marketId: "EG", userId, credentialId: `cred-${randomUUID()}`, publicKey: new Uint8Array([1, 2, 3]), counter: 0,
  transports: ["internal"], backupEligible: true, aaguid: null, userHandle: randomBytes(32).toString("base64url"), createdAt: new Date("2026-01-01T00:00:00Z"), lastUsedAt: null, ...o,
});

describe("PgPasskeyStore (outlet_auth under FORCE RLS)", () => {
  it("round-trips a credential, finds it by credential id pre-auth and lists it for the owner only", async () => {
    const u = await user();
    const c = cred(u);
    await store.insert(c);
    expect(await store.findByCredentialId("EG", c.credentialId)).toEqual(c);
    expect(await store.listByUser("EG", u)).toEqual([c]);
    expect(await store.listByUser("EG", await user())).toEqual([]);
  });

  it("an unknown credential, another market and a revoked credential are not found", async () => {
    const u = await user();
    const c = cred(u);
    await store.insert(c);
    expect(await store.findByCredentialId("EG", "nope")).toBeNull();
    expect(await store.findByCredentialId("AE", c.credentialId)).toBeNull();
    await admin.query("UPDATE passkey_credentials SET revoked_at = now() WHERE id = $1", [c.id]);
    expect(await store.findByCredentialId("EG", c.credentialId)).toBeNull();
    expect(await store.listByUser("EG", u)).toEqual([]);
  });

  it("the counter must strictly increase; a replay or rollback is rejected and the row is unchanged", async () => {
    const c = cred(await user());
    await store.insert(c);
    await store.recordUse(c, 5, new Date("2026-02-01T00:00:00Z"));
    expect((await store.findByCredentialId("EG", c.credentialId))?.counter).toBe(5);
    await expect(store.recordUse(c, 5, new Date())).rejects.toMatchObject({ status: 401 });
    await expect(store.recordUse(c, 3, new Date())).rejects.toMatchObject({ status: 401 });
    expect((await store.findByCredentialId("EG", c.credentialId))?.counter).toBe(5);
  });

  it("an authenticator that never counts (0 -> 0) still signs in", async () => {
    const c = cred(await user());
    await store.insert(c);
    await store.recordUse(c, 0, new Date("2026-02-01T00:00:00Z"));
    expect((await store.findByCredentialId("EG", c.credentialId))?.lastUsedAt).toEqual(new Date("2026-02-01T00:00:00Z"));
  });

  it("a duplicate credential id is refused (UNIQUE)", async () => {
    const u = await user();
    const c = cred(u);
    await store.insert(c);
    await expect(store.insert({ ...cred(u), credentialId: c.credentialId })).rejects.toThrow();
  });

  it("the user context cannot read or insert another user's credential", async () => {
    const a = await user();
    const b = await user();
    const c = cred(a);
    await store.insert(c);
    expect(await store.listByUser("EG", b)).toEqual([]);
    const auth = roleClient(admin, "outlet_auth");
    await expect(auth.query("SELECT 1 FROM passkey_credentials")).resolves.toMatchObject({ rows: [] });
  });
});

describe("PgPasskeyStore revoke and user handle (migration 0024)", () => {
  it("round-trips the handle; revoke is owner-only and idempotent", async () => {
    const a = await user();
    const b = await user();
    const c = cred(a);
    await store.insert(c);
    expect((await store.listByUser("EG", a))[0]?.userHandle).toBe(c.userHandle);
    expect(await store.revoke("EG", b, c.id, new Date())).toBe(false);
    expect(await store.revoke("EG", a, c.id, new Date())).toBe(true);
    expect(await store.revoke("EG", a, c.id, new Date())).toBe(false);
    expect(await store.findByCredentialId("EG", c.credentialId)).toBeNull();
  });
});
