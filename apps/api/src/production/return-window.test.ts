import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sellerSettings as ss } from "@outlet/domain";
import { createTestDatabaseUpTo } from "@outlet/db";
import { afterAll, describe, expect, it } from "vitest";
import { createIdGenerator, nodeCsprng } from "../platform";
import { createPgliteDatabase, type PgliteInstance } from "../platform/db";
import { InMemoryOrderRepository, OrderCommands, PlaceOrders, FakeOrderIntake } from "../modules/orders";
import {
  InMemorySettingsRepository,
  KyselySettingsRepository,
  SettingsReturnWindowAdapter,
  type SettingsDb,
  type SettingsRepository,
} from "../modules/seller-settings";
import { ORDER_A, SHOPPER_A, STAFF_A, STORE_A, TestClock, GROUP_1, sellerScope } from "../modules/orders/test/fixtures";

const DAY = 86_400_000;
const MIGRATION = fileURLToPath(new URL("../../../../packages/db/migrations/0055_seller_settings.sql", import.meta.url));
const open: SettingsDb[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

const pgSettings = async (): Promise<SettingsRepository> => {
  const raw = await createTestDatabaseUpTo(11);
  await raw.exec(readFileSync(MIGRATION, "utf8"));
  const db: SettingsDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return new KyselySettingsRepository(db);
};

const profile = (days: number, defect: number) => ({
  storeId: STORE_A,
  nameAr: "متجر",
  nameEn: null,
  descriptionAr: null,
  descriptionEn: null,
  logoKey: null,
  coverKey: null,
  socialLinks: {},
  returnPolicy: { ...ss.DEFAULT_RETURN_POLICY, changeOfMindDays: days, defectDays: defect },
  freeDeliveryThreshold: ss.DEFAULT_FREE_DELIVERY_THRESHOLD,
  vacation: ss.NO_VACATION,
  version: 1,
  updatedBy: null,
  updatedAtMs: 0,
});

describe.each([
  ["in-memory", async () => new InMemorySettingsRepository() as SettingsRepository],
  ["kysely/pglite", pgSettings],
])("SellerReturnWindowPort over %s settings", (_n, make) => {
  it("null without a profile; max(change-of-mind, defect) with one", async () => {
    const repo = await make();
    const port = new SettingsReturnWindowAdapter(repo);
    expect(await port.returnWindowDays(STORE_A)).toBeNull();
    await repo.saveProfile(profile(14, 30), null);
    expect(await port.returnWindowDays(STORE_A)).toBe(30);
    await repo.saveProfile({ ...profile(60, 45), version: 2 }, 1);
    expect(await port.returnWindowDays(STORE_A)).toBe(60);
  });

  it("domain bounds: 29 rejected, 30 and 90 ok, 91 rejected", () => {
    const v = (d: number) => ss.validateReturnPolicy({ changeOfMindDays: 14, defectDays: d, textAr: null, textEn: null });
    expect(() => v(29)).toThrow();
    expect(v(30).defectDays).toBe(30);
    expect(v(90).defectDays).toBe(90);
    expect(() => v(91)).toThrow();
  });

  it("closeDelivered with a 45-day window waits 48 days, not 33", async () => {
    const repo = await make();
    await repo.saveProfile(profile(14, 45), null);
    const clock = new TestClock();
    const orders = new InMemoryOrderRepository(clock, (() => {
      let n = 0;
      return () => `00000000-0000-4000-8000-${String(900_000 + n++).padStart(12, "0")}`;
    })());
    const cmds = new OrderCommands({
      repo: orders,
      clock,
      ids: createIdGenerator(clock, nodeCsprng),
      sellerWindows: new SettingsReturnWindowAdapter(repo),
    });
    const intake = new FakeOrderIntake(new PlaceOrders(orders, clock));
    await intake.placeOrder({
      groupId: GROUP_1,
      userId: SHOPPER_A,
      paidAtMs: clock.nowMs(),
      stores: [{ sellerOrderId: ORDER_A, storeId: STORE_A, lines: 1 }],
    });
    const s = sellerScope(STAFF_A, STORE_A);
    await cmds.accept({ sellerOrderId: ORDER_A, scope: s, actorId: STAFF_A, idempotencyKey: "a" });
    await cmds.pack({ sellerOrderId: ORDER_A, scope: s, actorId: STAFF_A, idempotencyKey: "p" });
    await cmds.markShipped({ sellerOrderId: ORDER_A, commandKey: "s" });
    await cmds.markDelivered({ sellerOrderId: ORDER_A, deliveredAtMs: clock.nowMs(), commandKey: "e" });
    clock.advance(40 * DAY);
    expect(await cmds.closeDelivered(10)).toEqual({ closed: 0, skipped: 1, failed: 0 });
    clock.advance(9 * DAY);
    expect(await cmds.closeDelivered(10)).toEqual({ closed: 1, skipped: 0, failed: 0 });
  });
});
