import { afterAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createTestDatabaseUpTo } from "@outlet/db";
import { createPgliteDatabase, type PgliteInstance } from "./platform/db";
import { KyselyWishlistRepository } from "./modules/wishlists/adapters/kysely-store";
import type { Wishlist } from "./modules/wishlists/domain/types";
import { KyselySizeProfileRepository } from "./modules/sizing/adapters/kysely-store";
import type { ProfileRecord } from "./modules/sizing/domain/ports";
import { createSizingDatabase } from "./modules/sizing/test/pglite-db";
import { KyselyPushTokenRepository } from "./modules/notifications/adapters/kysely-store";
import { createNotificationsDatabase } from "./modules/notifications/test/pglite-db";

const N = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
const T = 1_800_000_000_000;
const open: Kysely<Record<string, never>>[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

const list = (id: string, userId: string, over: Partial<Wishlist> = {}): Wishlist => ({
  id, userId, intent: "need", title: "mine", targetDate: null, budget: null, giftFor: null,
  coolOffEnabled: false, share: null, createdAtMs: T, updatedAtMs: T, ...over,
});

async function wishlistFixture() {
  const raw = await createTestDatabaseUpTo(15);
  const db = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  for (const u of [N(1), N(2)]) await raw.query(`insert into users (id, status) values ($1, 'active')`, [u]);
  return new KyselyWishlistRepository(db);
}

describe("wave 2 adversarial: confirmed defects", () => {
  // ADV-W2-1 lost update: save() writes every column from a stale read.
  it("a stale save must not resurrect a revoked share link", async () => {
    const repo = await wishlistFixture();
    await repo.insert(
      list(N(100), N(1), {
        share: { tokenHash: "ab".repeat(32), createdAtMs: T, expiresAtMs: null, revokedAtMs: null, hidePrices: false },
      }),
    );
    const stale = await repo.get(N(100));
    const fresh = await repo.get(N(100));
    if (stale === null || fresh === null || fresh.share === null) throw new Error("setup");
    await repo.save({ ...fresh, share: { ...fresh.share, revokedAtMs: T + 1 }, updatedAtMs: T + 1 });
    await repo.save({ ...stale, title: "renamed", updatedAtMs: T + 2 });
    expect((await repo.get(N(100)))?.share?.revokedAtMs).not.toBeNull();
  });

  // ADV-W2-2 the adapter runs as `system` (RLS bypassed) and updates by id only.
  it("save must not overwrite another user's wishlist", async () => {
    const repo = await wishlistFixture();
    await repo.insert(list(N(200), N(2), { title: "bob private" }));
    await repo.save(list(N(200), N(1), { title: "pwned by alice" }));
    expect((await repo.get(N(200)))?.title).toBe("bob private");
  });

  // ADV-W2-3 cursor validity depends on the cursor row still being live.
  it("a profile cursor survives deletion of the profile it points at", async () => {
    const { db } = await createSizingDatabase();
    open.push(db);
    const repo = new KyselySizeProfileRepository(db);
    await seedUsers(db, [N(1)]);
    const mk = (n: number): ProfileRecord => ({
      id: N(300 + n), userId: N(1), kind: "me", labelEnc: new Uint8Array([1, 2, 3, 4]),
      measurementsEnc: null, quickStartEnc: null, fitPreference: "regular", modestFit: false,
      version: 1, createdAtMs: T, updatedAtMs: T,
    });
    for (const n of [1, 2, 3]) await repo.insert(mk(n));
    const first = await repo.list(N(1), { cursor: null, limit: 1 });
    if (first === "invalid_cursor") throw new Error("setup");
    expect(first.nextCursor).not.toBeNull();
    await repo.delete(N(1), first.items[0]?.id ?? N(301));
    const next = await repo.list(N(1), { cursor: first.nextCursor, limit: 5 });
    expect(next).not.toBe("invalid_cursor");
  });

  // ADV-W2-4 device hand-over: the previous account keeps receiving this device's pushes.
  it("one push token is active for at most one user", async () => {
    const { db } = await createNotificationsDatabase();
    open.push(db);
    await seedUsers(db, [N(1), N(2)]);
    const repo = new KyselyPushTokenRepository(db);
    const token = "ExponentPushToken[shared-device-0001]";
    await repo.upsert(N(1), { installId: N(11), platform: "ios", token }, T);
    await repo.upsert(N(2), { installId: N(12), platform: "ios", token }, T + 1000);
    const a = await repo.active(N(1));
    const b = await repo.active(N(2));
    expect(a.filter((x) => x.token === token).length + b.filter((x) => x.token === token).length).toBe(1);
  });
});

async function seedUsers(db: Kysely<Record<string, never>>, ids: string[]): Promise<void> {
  const { sql } = await import("kysely");
  for (const id of ids) await sql`insert into users (id, status) values (${id}::uuid, 'active') on conflict do nothing`.execute(db);
}
