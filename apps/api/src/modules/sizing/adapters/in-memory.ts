import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Actor, Resource } from "@outlet/policy";
import type { BrandHistory, ItemCounts } from "../domain/bridge";
import type {
  DeliveredLine,
  DemandRepository,
  FeedbackRecord,
  FeedbackRepository,
  FieldCipherPort,
  FitCatalogPort,
  MeasurementsConsentPort,
  OrderLineFitPort,
  Page,
  ProductFitFacts,
  ProfileRecord,
  SizeChartRepository,
  SizeProfileRepository,
  SizingEvent,
  SizingEventPublisher,
  StoredChart,
} from "../domain/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Keyset cursor: the (createdAtMs, id) of the last item served. It never references a live row. */
const encodeCursor = (createdAtMs: number, seq: number, id: string, scope: string): string =>
  Buffer.from(`${String(createdAtMs)}|${String(seq)}|${id}|${scope}`, "utf8").toString("base64url");
function decodeCursor(cursor: string | null, scope: string): { ms: number; seq: number; id: string } | null | "invalid" {
  if (cursor === null) return null;
  const s = Buffer.from(cursor, "base64url").toString("utf8");
  const m = /^(\d{1,15})\|(\d{1,9})\|([0-9a-f-]{36})\|([0-9a-f-]{36})$/.exec(s);
  if (m === null || !UUID.test(m[3] ?? "") || m[4] !== scope) return "invalid";
  return { ms: Number(m[1]), seq: Number(m[2]), id: m[3] ?? "" };
}

/** Keyset pagination ordered by (createdAtMs, id). */
function paginate<T extends { readonly id: string; readonly createdAtMs: number }>(
  source: readonly T[],
  seqOf: (x: T) => number,
  page: { cursor: string | null; limit: number },
  scope: string,
): Page<T> | "invalid_cursor" {
  const after = decodeCursor(page.cursor, scope);
  if (after === "invalid") return "invalid_cursor";
  const cmp = (x: T, y: T): number =>
    x.createdAtMs - y.createdAtMs || seqOf(x) - seqOf(y) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  const sorted = [...source].sort(cmp);
  const rest =
    after === null
      ? sorted
      : sorted.filter(
          (x) =>
            x.createdAtMs > after.ms ||
            (x.createdAtMs === after.ms && (seqOf(x) > after.seq || (seqOf(x) === after.seq && x.id > after.id))),
        );
  const items = rest.slice(0, page.limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rest.length > page.limit && last !== undefined ? encodeCursor(last.createdAtMs, seqOf(last), last.id, scope) : null };
}

export class InMemorySizeProfileRepository implements SizeProfileRepository {
  private readonly rows = new Map<string, ProfileRecord>();

  async countLive(userId: string): Promise<number> {
    return [...this.rows.values()].filter((r) => r.userId === userId).length;
  }
  async insert(record: ProfileRecord): Promise<void> {
    this.rows.set(record.id, record);
  }
  async get(userId: string, id: string): Promise<ProfileRecord | null> {
    const r = this.rows.get(id);
    return r !== undefined && r.userId === userId ? r : null;
  }
  async list(userId: string, page: { cursor: string | null; limit: number }) {
    const mine = [...this.rows.values()].filter((r) => r.userId === userId).sort((a, b) => (a.id < b.id ? -1 : 1));
    return paginate(mine, () => 0, page, userId);
  }
  async update(record: ProfileRecord, expectedVersion: number): Promise<"updated" | "conflict" | "not_found"> {
    const cur = this.rows.get(record.id);
    if (cur === undefined || cur.userId !== record.userId) return "not_found";
    if (cur.version !== expectedVersion) return "conflict";
    this.rows.set(record.id, record);
    return "updated";
  }
  async delete(userId: string, id: string): Promise<boolean> {
    const r = this.rows.get(id);
    if (r === undefined || r.userId !== userId) return false;
    this.rows.delete(id);
    return true;
  }
  /** Test helper: what an attacker with database access would see. */
  rawRecords(): readonly ProfileRecord[] {
    return [...this.rows.values()];
  }
}

export class InMemorySizeChartRepository implements SizeChartRepository {
  private readonly rows: StoredChart[] = [];

  async nextVersion(storeId: string, productType: string): Promise<number> {
    return (
      this.rows.filter((c) => c.storeId === storeId && c.productType === productType).reduce((m, c) => Math.max(m, c.chartVersion), 0) +
      1
    );
  }
  async insert(chart: StoredChart): Promise<void> {
    this.rows.push(chart);
  }
  async listForStore(storeId: string, page: { cursor: string | null; limit: number }) {
    return paginate(
      this.rows.filter((c) => c.storeId === storeId),
      (c) => c.chartVersion,
      page,
      storeId,
    );
  }
  async latestValidated(storeId: string, productType: string): Promise<StoredChart | null> {
    const hits = this.rows.filter((c) => c.storeId === storeId && c.productType === productType && c.validated);
    return hits.reduce<StoredChart | null>((best, c) => (best === null || c.chartVersion > best.chartVersion ? c : best), null);
  }
}

export class InMemoryFeedbackRepository implements FeedbackRepository {
  private readonly rows: FeedbackRecord[] = [];

  async insert(record: FeedbackRecord): Promise<"created" | "duplicate"> {
    if (this.rows.some((r) => r.orderLineId === record.orderLineId)) return "duplicate";
    this.rows.push(record);
    return "created";
  }
  async historyFor(userId: string, brandId: string): Promise<BrandHistory> {
    const mine = this.rows.filter((r) => r.userId === userId && r.brandId === brandId);
    return {
      tooSmall: mine.filter((r) => r.rating === "too_small").length,
      tooLarge: mine.filter((r) => r.rating === "too_large").length,
    };
  }
  async itemCounts(productId: string, sizeChartId: string): Promise<ItemCounts> {
    const hits = this.rows.filter((r) => r.productId === productId && r.sizeChartId === sizeChartId);
    return {
      nSmall: hits.filter((r) => r.rating === "too_small").length,
      nOk: hits.filter((r) => r.rating === "ok").length,
      nLarge: hits.filter((r) => r.rating === "too_large").length,
    };
  }
  async detachProfile(userId: string, profileId: string): Promise<void> {
    this.rows.forEach((r, i) => {
      if (r.userId === userId && r.profileId === profileId) this.rows[i] = { ...r, profileId: null };
    });
  }
  /** Test helper (arrange). */
  seed(record: FeedbackRecord): void {
    this.rows.push(record);
  }
}

export class InMemoryDemandRepository implements DemandRepository {
  /** demandCount is the number of DISTINCT shoppers per cell (k-anonymity counts people, not requests). */
  private readonly cells = new Map<string, { storeId: string; productType: string; sizeLabel: string; week: string; shoppers: Set<string> }>();

  async record(storeId: string, productType: string, sizeLabel: string, week: string, shopperId: string): Promise<void> {
    const key = JSON.stringify([storeId, productType, sizeLabel, week]);
    const cur = this.cells.get(key) ?? { storeId, productType, sizeLabel, week, shoppers: new Set<string>() };
    cur.shoppers.add(shopperId);
    this.cells.set(key, cur);
  }
  async cellsForStore(storeId: string) {
    return [...this.cells.values()]
      .filter((c) => c.storeId === storeId)
      .map(({ productType, sizeLabel, week, shoppers }) => ({ productType, sizeLabel, week, demandCount: shoppers.size }));
  }
  /** Test helper (arrange): `demandCount` distinct synthetic shoppers. */
  seed(storeId: string, productType: string, sizeLabel: string, week: string, demandCount: number): void {
    const shoppers = new Set<string>();
    for (let i = 0; i < demandCount; i += 1) shoppers.add(`seed-shopper-${i}`);
    this.cells.set(JSON.stringify([storeId, productType, sizeLabel, week]), { storeId, productType, sizeLabel, week, shoppers });
  }
}

/**
 * DEVELOPMENT FIXTURE. Real AES-256-GCM with a process-local random key so that ciphertext is
 * genuinely opaque in tests, but the key is not managed, rotated or escrowed. Production wires a
 * KMS-backed envelope cipher behind the same port (spec T5).
 */
export class DevAesGcmFieldCipher implements FieldCipherPort {
  private readonly key: Buffer;
  private failing = false;

  constructor(key: Buffer = randomBytes(32)) {
    this.key = key;
  }
  /** Test helper: simulate the KMS being down. */
  setFailing(v: boolean): void {
    this.failing = v;
  }
  async encrypt(plaintext: Uint8Array, aad: string): Promise<Uint8Array> {
    if (this.failing) throw new Error("kms unavailable");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(aad, "utf8"));
    const body = Buffer.concat([c.update(plaintext), c.final()]);
    return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), body]));
  }
  async decrypt(ciphertext: Uint8Array, aad: string): Promise<Uint8Array> {
    if (this.failing) throw new Error("kms unavailable");
    const buf = Buffer.from(ciphertext);
    const d = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12), { authTagLength: 16 });
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(buf.subarray(12, 28));
    try {
      return new Uint8Array(Buffer.concat([d.update(buf.subarray(28)), d.final()]));
    } catch {
      // Same contract as EnvelopeFieldCipher: an authentication failure is an integrity fault, not an outage.
      throw new Error("bad_ciphertext");
    }
  }
}

/** DEVELOPMENT FIXTURE consent source. The integrator replaces it with the privacy module's repository. */
export class InMemoryMeasurementsConsent implements MeasurementsConsentPort {
  private readonly granted = new Set<string>();
  async isGranted(userId: string): Promise<boolean> {
    return this.granted.has(userId);
  }
  grant(userId: string): void {
    this.granted.add(userId);
  }
  withdraw(userId: string): void {
    this.granted.delete(userId);
  }
}

/** DEVELOPMENT FIXTURE. Synthetic facts, seeded by tests and the dev seed. */
export class InMemoryFitCatalog implements FitCatalogPort {
  private readonly products = new Map<string, ProductFitFacts>();
  async productFitFacts(productId: string): Promise<ProductFitFacts | null> {
    return this.products.get(productId) ?? null;
  }
  seed(facts: ProductFitFacts): void {
    this.products.set(facts.productId, facts);
  }
}

export class InMemoryOrderLines implements OrderLineFitPort {
  private readonly lines = new Map<string, { userId: string; result: DeliveredLine }>();
  async lineFor(userId: string, orderLineId: string): Promise<DeliveredLine | null> {
    const l = this.lines.get(orderLineId);
    return l !== undefined && l.userId === userId ? l.result : null;
  }
  seed(userId: string, orderLineId: string, result: DeliveredLine): void {
    this.lines.set(orderLineId, { userId, result });
  }
}

export class InMemorySizingEventLog implements SizingEventPublisher {
  readonly events: SizingEvent[] = [];
  async publish(event: SizingEvent): Promise<void> {
    this.events.push(event);
  }
}

/**
 * Seller routes carry no object id (the store comes from the token's brand grant), so the policy
 * resource is "the actor's own store". An actor without a brand grant resolves to null (deny).
 */
export class SizingStoreResolver {
  async resolve(input: { id: string | undefined; actor: Actor }): Promise<Resource | null> {
    const grant = input.actor.grants.find((g) => g.kind === "brand");
    if (grant === undefined || grant.kind !== "brand") return null;
    return { type: "store_product", id: `size-charts:${grant.storeId}`, storeId: grant.storeId, state: "active" };
  }
}
