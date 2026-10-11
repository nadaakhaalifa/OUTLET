import { createIdGenerator, nodeCsprng, type Clock } from "../../../platform";
import {
  FakeResaleCatalog,
  FakeResaleConsent,
  FakeResaleLedger,
  FakeReturnFacts,
  InMemoryResaleMetrics,
  InMemoryResaleStore,
  StaticResaleFlags,
  StaticResaleTerms,
} from "../adapters/in-memory";
import type { ResaleDeps } from "../application/resale";
import type { ListingRecord, ReturnFacts } from "../domain/ports";

export const START_MS = 1_800_000_000_000;
export const DAY = 86_400_000;
export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
export const STORE_A = U(1000);
export const STORE_B = U(1001);
export const HUB_1 = U(100);
export const HUB_2 = U(101);

export class FakeClock implements Clock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export const returnFacts = (n: number, over: Partial<ReturnFacts> = {}): ReturnFacts => ({
  returnId: U(3000 + n),
  unitRef: U(3100 + n),
  sourceSkuId: U(3200 + n),
  storeId: STORE_A,
  hubId: HUB_1,
  inspectionPassed: true,
  returnClass: "standard",
  ownership: "seller",
  ...over,
});

export const listing = (n: number, over: Partial<ListingRecord> = {}): ListingRecord => ({
  id: U(4000 + n),
  returnId: U(3000 + n),
  unitRef: U(3100 + n),
  storeId: STORE_A,
  sourceSkuId: U(3200 + n),
  resaleSkuId: U(3300 + n),
  grade: "B",
  photoIds: ["p1", "p2"],
  defectNote: null,
  price: 80_000n,
  ownership: "seller",
  status: "LISTED",
  listedAtMs: START_MS + n * 1_000,
  soldAtMs: null,
  createdBy: U(11),
  ...over,
});

export interface Fixture {
  readonly clock: FakeClock;
  readonly store: InMemoryResaleStore;
  readonly returns: FakeReturnFacts;
  readonly consent: FakeResaleConsent;
  readonly terms: StaticResaleTerms;
  readonly catalog: FakeResaleCatalog;
  readonly flags: StaticResaleFlags;
  readonly ledger: FakeResaleLedger;
  readonly deps: ResaleDeps;
}

export function createFixture(): Fixture {
  const clock = new FakeClock();
  const store = new InMemoryResaleStore();
  const returns = new FakeReturnFacts();
  const consent = new FakeResaleConsent();
  const terms = new StaticResaleTerms();
  const catalog = new FakeResaleCatalog();
  const flags = new StaticResaleFlags(true);
  const ledger = new FakeResaleLedger();
  const deps: ResaleDeps = { store, returns, consent, terms, catalog, flags, ledger, metrics: new InMemoryResaleMetrics(), clock, ids: createIdGenerator(clock, nodeCsprng) };
  return { clock, store, returns, consent, terms, catalog, flags, ledger, deps };
}
