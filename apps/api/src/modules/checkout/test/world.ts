import { createIdGenerator, nodeCsprng } from "../../../platform";
import type { Clock } from "../../../platform/ports";
import { InMemorySagaRepository } from "../adapters/in-memory";
import {
  FakeAddresses,
  FakeAgePolicy,
  FakeAppAttest,
  FakeCart,
  FakeCodConfirmation,
  FakeInventory,
  FakeKillSwitch,
  FakeLedger,
  FakeMetrics,
  FakeOrdersIntake,
  FakePaymentProvider,
  FakePromotions,
  FakeRisk,
  FakeStoreCredit,
  FakeTax,
  StaticPaymentRegistry,
} from "../adapters/fakes";
import type { CheckoutContext } from "../application/context";
import { money, type Money } from "../domain/bridge";
import type { BagLine, BagSnapshot, SagaRepository } from "../domain/ports";

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
export const SHOPPER = U(1);
export const OTHER_SHOPPER = U(2);
export const STORE_A = "00000000-0000-4000-a000-00000000000a";
export const STORE_B = "00000000-0000-4000-a000-00000000000b";
export const SKU_1 = U(501);
export const SKU_2 = U(502);
export const LINE_1 = U(601);
export const LINE_2 = U(602);
export const ADDRESS = U(701);
export const LOCK_SECRET = "test-lock-secret-not-for-production";

export class CrashError extends Error {
  constructor(readonly point: string) {
    super(`simulated process kill at ${point}`);
    this.name = "CrashError";
  }
}

/** Deterministic step-interleaving: kills the "process" at the Nth port call (before or after it). */
export class CrashController {
  private count = 0;
  private target: number | null = null;
  private dead = false;
  fired = 0;
  readonly labels: string[] = [];
  arm(target: number | null): void {
    this.target = target;
    this.count = 0;
  }
  ticks(): number {
    return this.count;
  }
  revive(): void {
    this.dead = false;
    this.target = null;
  }
  tick(label: string): void {
    if (this.dead) throw new CrashError(`${label} (dead)`);
    const n = this.count;
    this.count += 1;
    this.labels[n] = label;
    if (this.target !== null && n === this.target) {
      this.dead = true;
      this.fired += 1;
      throw new CrashError(label);
    }
  }
}

function crashy<T extends object>(t: T, ctl: CrashController, label: string): T {
  return new Proxy(t, {
    get(target, prop) {
      const v: unknown = Reflect.get(target, prop, target);
      if (typeof v !== "function" || typeof prop !== "string") return v;
      return (...args: unknown[]) => {
        ctl.tick(`${label}.${prop}:before`);
        const r: unknown = (v as (...a: unknown[]) => unknown).apply(target, args);
        if (r instanceof Promise) {
          return r.then((x: unknown) => {
            ctl.tick(`${label}.${prop}:after`);
            return x;
          });
        }
        return r;
      };
    },
  });
}

export function bagLine(over: Partial<BagLine> & { lineId: string; skuId: string; storeId: string; price: bigint }): BagLine {
  return {
    lineId: over.lineId,
    skuId: over.skuId,
    productId: over.productId ?? U(800),
    storeId: over.storeId,
    qty: over.qty ?? 1,
    unitPrice: money(over.price),
    isDrop: over.isDrop ?? false,
    available: over.available ?? true,
    title: over.title ?? { ar: "فستان", en: "Dress" },
    taxCategoryCode: over.taxCategoryCode ?? "standard",
  };
}

export interface WorldOptions {
  readonly repo?: SagaRepository;
  readonly plus?: boolean;
  readonly requireAppAttest?: boolean;
  readonly promos?: ConstructorParameters<typeof FakePromotions>[0];
}

export function defaultBag(plus = false): BagSnapshot {
  return {
    lines: [
      bagLine({ lineId: LINE_1, skuId: SKU_1, storeId: STORE_A, price: 150_000n }),
      bagLine({ lineId: LINE_2, skuId: SKU_2, storeId: STORE_B, price: 80_000n }),
    ],
    stores: new Map([
      [STORE_A, { storeId: STORE_A, open: true, commissionBps: 1_500, freeDeliveryThreshold: money(200_000n), standardDeliveryFee: money(4_000n) }],
      [STORE_B, { storeId: STORE_B, open: true, commissionBps: 1_000, freeDeliveryThreshold: money(200_000n), standardDeliveryFee: money(4_000n) }],
    ]),
    plusMember: plus,
  };
}

/** Everything wired with fakes. `ctx` is what use cases see (crash-wrapped); fakes expose the truth. */
export function createWorld(opts: WorldOptions = {}) {
  const clock = new TestClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const crash = new CrashController();
  const repo = opts.repo ?? new InMemorySagaRepository();
  const cart = new FakeCart();
  const inventory = new FakeInventory(clock);
  const credit = new FakeStoreCredit();
  const provider = new FakePaymentProvider("fake-psp", clock);
  const ledger = new FakeLedger();
  const orders = new FakeOrdersIntake();
  const risk = new FakeRisk();
  const agePolicy = new FakeAgePolicy();
  const killSwitch = new FakeKillSwitch();
  const addresses = new FakeAddresses();
  const metrics = new FakeMetrics();
  addresses.add(SHOPPER, ADDRESS);
  cart.set(SHOPPER, defaultBag(opts.plus ?? false));
  inventory.setStock(SKU_1, 5);
  inventory.setStock(SKU_2, 5);

  const wrappedProvider = crashy(provider, crash, "psp");
  const ctx: CheckoutContext = {
    repo: crashy(repo, crash, "repo"),
    cart: crashy(cart, crash, "cart"),
    promotions: new FakePromotions(opts.promos ?? []),
    tax: new FakeTax(),
    risk,
    agePolicy,
    killSwitch,
    addresses,
    appAttest: new FakeAppAttest(),
    codConfirmation: new FakeCodConfirmation(),
    inventory: crashy(inventory, crash, "inventory"),
    credit: crashy(credit, crash, "credit"),
    payments: new StaticPaymentRegistry([wrappedProvider]),
    ledger: crashy(ledger, crash, "ledger"),
    orders: crashy(orders, crash, "orders"),
    metrics,
    clock,
    ids,
    lockSecret: LOCK_SECRET,
    requireAppAttest: opts.requireAppAttest ?? false,
  };
  return { clock, ids, crash, repo, cart, inventory, credit, provider, ledger, orders, risk, agePolicy, killSwitch, addresses, metrics, ctx };
}
export type World = ReturnType<typeof createWorld>;

export const piastres = (n: bigint): Money => money(n);
