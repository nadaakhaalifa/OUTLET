import { createIdGenerator, nodeCsprng } from "../../../platform";
import type { Clock } from "../../../platform/ports";
import { FakeOrderIntake } from "../adapters/fake-intake";
import { OrderCommands } from "../application/commands";
import { PlaceOrders } from "../application/intake";
import type { OrderRepository } from "../domain/ports";

export const T0 = 1_800_000_000_000;

export class TestClock implements Clock {
  constructor(private ms = T0) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const SHOPPER_A = U(1);
export const SHOPPER_B = U(2);
export const STAFF_A = U(11);
export const STAFF_B = U(12);
export const STORE_A = "00000000-0000-4000-a000-00000000000a";
export const STORE_B = "00000000-0000-4000-a000-00000000000b";
export const GROUP_1 = U(100);
export const ORDER_A = U(201);
export const ORDER_B = U(202);
export const GROUP_2 = U(101);
export const ORDER_A2 = U(203);

export interface Kit {
  readonly repo: OrderRepository;
  readonly clock: TestClock;
  readonly commands: OrderCommands;
  readonly intake: FakeOrderIntake;
}

export function kit(repo: OrderRepository, clock: TestClock): Kit {
  const ids = createIdGenerator(clock, nodeCsprng);
  return {
    repo,
    clock,
    commands: new OrderCommands({ repo, clock, ids }),
    intake: new FakeOrderIntake(new PlaceOrders(repo, clock)),
  };
}

/** One group of two seller orders (store A and store B) for shopper A, paid at the clock's now. */
export async function placeTwoStoreGroup(k: Kit, over: { paymentMethod?: "card" | "cod" } = {}) {
  return k.intake.placeOrder({
    groupId: GROUP_1,
    userId: SHOPPER_A,
    paidAtMs: k.clock.nowMs(),
    ...(over.paymentMethod !== undefined ? { paymentMethod: over.paymentMethod } : {}),
    stores: [
      { sellerOrderId: ORDER_A, storeId: STORE_A, lines: 2 },
      { sellerOrderId: ORDER_B, storeId: STORE_B },
    ],
  });
}

export const sellerScope = (userId: string, ...storeIds: string[]) =>
  ({ kind: "seller", userId, storeIds }) as const;
