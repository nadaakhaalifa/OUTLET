import { afterAll, describe, expect, it } from "vitest";
import { InMemoryAppAttest, InMemoryReferralIdentity, InMemoryReferralStore } from "./modules/referrals/adapters/in-memory";
import { KyselyReferralStore, type ReferralDb } from "./modules/referrals/adapters/kysely-store";
import { createReferralDatabase } from "./modules/referrals/test/pglite-db";
import { AttributeReferral, HandleOrderClosed, type ReferralRuntimeOptions } from "./modules/referrals/application/referrals";
import type { ReferralStore } from "./modules/referrals/domain/ports";
import { DEFAULT_REFERRAL_CONFIG } from "./modules/referrals/domain/rules";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++seq + 5000).padStart(12, "0")}` };
const REFERRER = U(1);
const CAP = 2;
const FRIENDS = 6;

async function scenario(store: ReferralStore, ensureUser: (id: string) => Promise<void>): Promise<number> {
  const opts: ReferralRuntimeOptions = {
    config: { ...DEFAULT_REFERRAL_CONFIG, maxRewardedPerWindow: CAP },
    requireAttest: false,
    deepLinkBase: "https://x.test/r",
  };
  const identity = new InMemoryReferralIdentity();
  const clock = { nowMs: () => T0 };
  identity.seed(REFERRER, { deviceHashes: ["d".repeat(64)], deliveredOrderCount: 2, paymentFingerprintHashes: ["e".repeat(64)] });
  await ensureUser(REFERRER);
  await store.ensureCode({ id: U(100), ownerUserId: REFERRER, code: "ABCDEFGH", nowMs: T0 });
  const attribute = new AttributeReferral(store, identity, new InMemoryAppAttest(), clock, ids, opts);
  const friends = Array.from({ length: FRIENDS }, (_, i) => U(10 + i));
  for (const [i, f] of friends.entries()) {
    await ensureUser(f);
    identity.seed(f, { deviceHashes: [String(i).padStart(64, "c")] });
    await attribute.execute(f, "ABCDEFGH", null);
  }
  const handler = new HandleOrderClosed(store, identity, clock, opts);
  await Promise.all(
    friends.map((f, i) =>
      handler.execute({
        messageId: U(200 + i),
        orderId: U(300 + i),
        userId: f,
        isFirstOrder: true,
        merchandiseSubtotal: 80_000n,
        refunded: false,
        paymentMethod: "prepaid",
        deliveredAtMs: T0,
        closedAtMs: T0 + 15 * DAY,
        paymentFingerprintHash: String(i).padStart(64, "f"),
      }),
    ),
  );
  return store.countRewarded(REFERRER, T0 - 365 * DAY);
}

describe("wave3 referrals: concurrent settlements vs yearly cap", () => {
  const open: ReferralDb[] = [];
  afterAll(async () => {
    await Promise.all(open.map((d) => d.destroy()));
  });

  it("in-memory store never rewards more than maxRewardedPerWindow under concurrent OrderClosed", async () => {
    const n = await scenario(new InMemoryReferralStore(), async () => undefined);
    expect(n).toBeLessThanOrEqual(CAP);
  });

  it("kysely/pglite store never rewards more than maxRewardedPerWindow under concurrent OrderClosed", async () => {
    const { pg, db } = await createReferralDatabase();
    open.push(db);
    const store = new KyselyReferralStore(db, ids);
    const n = await scenario(store, async (id) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    });
    expect(n).toBeLessThanOrEqual(CAP);
  });
});
