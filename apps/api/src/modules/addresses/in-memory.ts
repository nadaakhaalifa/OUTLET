import { addresses } from "@outlet/domain";
import type {
  AddressRow,
  AddressStore,
  AddressTx,
  CityRow,
  CoverageSource,
  GiftTokenRow,
  GovernorateRow,
  SnapshotRow,
} from "./ports";

export class FixtureCoverage implements CoverageSource {
  private readonly rows: addresses.CoverageEntry[] = [];
  constructor(entries?: readonly addresses.CoverageEntry[]) {
    if (entries !== undefined) this.rows.push(...entries);
    else this.rows.push(...seedEntries());
  }
  set(entries: readonly addresses.CoverageEntry[]): void {
    this.rows.splice(0, this.rows.length, ...entries);
  }
  private coveredGov(code: string): boolean {
    return this.rows.some((e) => e.governorateCode === code && e.cityCode === null && e.covered);
  }
  async governorates(): Promise<readonly (GovernorateRow & { covered: boolean })[]> {
    return addresses.GOVERNORATE_FIXTURES.map((g) => ({ code: g[0], nameAr: g[1], nameEn: g[2], covered: this.coveredGov(g[0]) }));
  }
  async cities(governorateCode: string): Promise<readonly (CityRow & { covered: boolean })[] | null> {
    const g = addresses.GOVERNORATE_FIXTURES.find((x) => x[0] === governorateCode);
    if (g === undefined) return null;
    return g[3].map((c) => ({
      governorateCode,
      code: c[0],
      nameAr: c[1],
      nameEn: c[2],
      covered: addresses.evaluateCoverage(this.rows, governorateCode, c[0]).coverage === "covered",
    }));
  }
  async entries(): Promise<readonly addresses.CoverageEntry[]> {
    return [...this.rows];
  }
}

/** The same rows the 0050 migration seeds (a test asserts they agree). */
export function seedEntries(): addresses.CoverageEntry[] {
  const cod = new Map(addresses.COURIER_FIXTURES.map(([c, v]) => [c, v]));
  const out: addresses.CoverageEntry[] = [];
  for (const [courier] of addresses.COURIER_FIXTURES) {
    for (const g of addresses.GOVERNORATE_FIXTURES) {
      out.push({
        courier,
        governorateCode: g[0],
        cityCode: null,
        covered: !(addresses.COURIER_GOVERNORATE_EXCLUSIONS[courier] ?? []).includes(g[0]),
        codSupported: cod.get(courier) === true,
      });
    }
  }
  for (const [courier, gov, city, covered] of addresses.COURIER_CITY_OVERRIDES) {
    out.push({ courier, governorateCode: gov, cityCode: city, covered, codSupported: cod.get(courier) === true });
  }
  return out;
}

const newestFirst = (a: AddressRow, b: AddressRow): number => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1);
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export class InMemoryAddressStore implements AddressStore {
  readonly coverage: FixtureCoverage;
  private readonly byUser = new Map<string, AddressRow[]>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly snapshots = new Map<string, SnapshotRow>();
  private readonly tokens = new Map<string, GiftTokenRow>();

  constructor(coverage: FixtureCoverage = new FixtureCoverage()) {
    this.coverage = coverage;
  }

  async run<T>(userId: string, fn: (tx: AddressTx) => Promise<T>): Promise<T> {
    const prev = this.locks.get(userId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const draft = [...(this.byUser.get(userId) ?? [])];
      const tx: AddressTx = {
        all: async () => [...draft].sort(newestFirst),
        get: async (id) => draft.find((r) => r.id === id) ?? null,
        insert: async (row) => {
          if (draft.some((r) => r.id === row.id)) throw new Error("duplicate id");
          this.checkIndexes(draft, row);
          draft.push(row);
        },
        update: async (row) => {
          const i = draft.findIndex((r) => r.id === row.id);
          if (i < 0) throw new Error("no such row");
          const without = draft.filter((r) => r.id !== row.id);
          this.checkIndexes(without, row);
          draft[i] = row;
        },
        remove: async (id) => {
          const i = draft.findIndex((r) => r.id === id);
          if (i >= 0) draft.splice(i, 1);
        },
      };
      const result = await fn(tx);
      this.byUser.set(userId, draft);
      return result;
    });
    this.locks.set(userId, next.catch(() => undefined));
    return next;
  }

  /** Mirrors the partial unique indexes of the SQL schema. */
  private checkIndexes(others: readonly AddressRow[], row: AddressRow): void {
    if (row.isDefault && others.some((r) => r.isDefault)) throw new Error("unique violation: one default per user");
    if (others.some((r) => hex(r.dedupeBlind) === hex(row.dedupeBlind))) throw new Error("unique violation: dedupe");
  }

  async page(userId: string, after: { createdAtMs: number; id: string } | null, limit: number): Promise<readonly AddressRow[]> {
    return [...(this.byUser.get(userId) ?? [])]
      .sort(newestFirst)
      .filter((r) => after === null || r.createdAtMs < after.createdAtMs || (r.createdAtMs === after.createdAtMs && r.id < after.id))
      .slice(0, limit);
  }

  async find(userId: string, id: string): Promise<AddressRow | null> {
    return (this.byUser.get(userId) ?? []).find((r) => r.id === id) ?? null;
  }

  async insertSnapshot(row: SnapshotRow): Promise<SnapshotRow> {
    const key = `${row.userId}|${row.orderRef}`;
    const existing = this.snapshots.get(key);
    if (existing !== undefined) return existing;
    this.snapshots.set(key, row);
    return row;
  }
  async findSnapshot(id: string): Promise<SnapshotRow | null> {
    return [...this.snapshots.values()].find((s) => s.id === id) ?? null;
  }
  async insertGiftToken(row: GiftTokenRow): Promise<void> {
    this.tokens.set(hex(row.tokenHash), row);
  }
  async findGiftToken(tokenHash: Uint8Array): Promise<GiftTokenRow | null> {
    const t = this.tokens.get(hex(tokenHash));
    if (t === undefined) return null;
    // Address removed => token dead (FK cascade in SQL).
    return (await this.find(t.ownerUserId, t.addressId)) === null ? null : t;
  }
  async revokeGiftToken(ownerUserId: string, tokenHash: Uint8Array, atMs: number): Promise<boolean> {
    const t = this.tokens.get(hex(tokenHash));
    if (t === undefined || t.ownerUserId !== ownerUserId || t.revokedAtMs !== null) return false;
    this.tokens.set(hex(tokenHash), { ...t, revokedAtMs: atMs });
    return true;
  }
}
