import { createHash } from "node:crypto";
import { addresses } from "@outlet/domain";
import type { Clock, IdGenerator } from "../../platform/ports";
import { AddressCodec, type PlainAddress } from "./codec";
import type { AddressRow, AddressStore, AddressTx, AddressView, SnapshotRow } from "./ports";

export interface FieldError {
  readonly field: string;
  readonly code: string;
}

export interface AddressInput {
  readonly label?: string | undefined;
  readonly recipientName: string;
  readonly phone: string;
  readonly governorateCode: string;
  readonly cityDistrictCode: string;
  readonly street: string;
  readonly building: string;
  readonly floor?: string | undefined;
  readonly apartment?: string | undefined;
  readonly landmark?: string | undefined;
  readonly mapPin?: addresses.MapPin | undefined;
}

/** `null` clears an optional field; `undefined` leaves it alone. */
export interface AddressPatch {
  readonly label?: string | null | undefined;
  readonly recipientName?: string | undefined;
  readonly phone?: string | undefined;
  readonly governorateCode?: string | undefined;
  readonly cityDistrictCode?: string | undefined;
  readonly street?: string | undefined;
  readonly building?: string | undefined;
  readonly floor?: string | null | undefined;
  readonly apartment?: string | null | undefined;
  readonly landmark?: string | null | undefined;
  readonly mapPin?: addresses.MapPin | null | undefined;
}

export type WriteOutcome =
  | { readonly kind: "ok"; readonly address: AddressView }
  | { readonly kind: "invalid"; readonly errors: readonly FieldError[] }
  | { readonly kind: "limit_reached" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "not_found" };

export interface DeliverySnapshot {
  readonly id: string;
  readonly orderRef: string;
  readonly gift: boolean;
  readonly governorateCode: string;
  readonly courierCoverage: addresses.CourierCoverage;
  readonly codEligible: boolean;
}

export type SnapshotOutcome =
  | { readonly kind: "ok"; readonly snapshot: DeliverySnapshot }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_covered" };

export const GIFT_TOKEN_PREFIX = "gift_";
const GIFT_TTL_MAX_MS = 90 * 86_400_000;
const hashToken = (t: string): Uint8Array => new Uint8Array(createHash("sha256").update(t, "utf8").digest());

export class AddressService {
  readonly codec: AddressCodec;

  constructor(
    private readonly store: AddressStore,
    cipher: ConstructorParameters<typeof AddressCodec>[0],
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly randomToken: () => string,
  ) {
    this.codec = new AddressCodec(cipher);
  }

  get coverage() {
    return this.store.coverage;
  }

  async list(userId: string, after: { createdAtMs: number; id: string } | null, limit: number): Promise<readonly AddressView[]> {
    const rows = await this.store.page(userId, after, limit);
    return Promise.all(rows.map((r) => this.codec.view(r)));
  }

  async get(userId: string, id: string): Promise<AddressView | null> {
    const row = await this.store.find(userId, id);
    return row === null ? null : this.codec.view(row);
  }

  private async validate(
    d: { recipientName: string; phone: string; governorateCode: string; cityDistrictCode: string; street: string; building: string; floor?: string | undefined; apartment?: string | undefined; landmark?: string | undefined; mapPin?: addresses.MapPin | undefined; label?: string | undefined },
  ): Promise<{ errors: FieldError[]; phone: string | null }> {
    const errors: FieldError[] = [];
    const phone = addresses.normalizeEgPhone(d.phone);
    if (phone === null) errors.push({ field: "phone_e164", code: "invalid_eg_phone" });
    if (d.mapPin !== undefined && !addresses.isValidEgyptMapPin(d.mapPin)) errors.push({ field: "map_pin", code: "outside_egypt" });
    const cities = await this.store.coverage.cities(d.governorateCode);
    if (cities === null) errors.push({ field: "governorate_code", code: "unknown_governorate" });
    else if (!cities.some((c) => c.code === d.cityDistrictCode)) errors.push({ field: "city_district_code", code: "unknown_city" });
    for (const [f, v, min] of [["recipient_name", d.recipientName, 2], ["street", d.street, 3], ["building", d.building, 1]] as const) {
      if (v.trim().length < min) errors.push({ field: f, code: "too_short" });
    }
    return { errors, phone };
  }

  private async build(
    userId: string,
    id: string,
    d: AddressInput,
    phone: string,
    base: { isDefault: boolean; createdAtMs: number },
    nowMs: number,
  ): Promise<AddressRow> {
    const cov = addresses.evaluateCoverage(await this.store.coverage.entries(), d.governorateCode, d.cityDistrictCode);
    const plain: PlainAddress = {
      recipientName: d.recipientName.trim(),
      phoneE164: phone,
      street: d.street.trim(),
      building: d.building.trim(),
      floor: blankToUndef(d.floor),
      apartment: blankToUndef(d.apartment),
      landmark: blankToUndef(d.landmark),
      mapPin: d.mapPin,
    };
    const sealed = await this.codec.seal("address", id, plain);
    const key = addresses.dedupeKey({ ...d, street: plain.street, building: plain.building });
    return {
      id,
      userId,
      label: blankToUndef(d.label) ?? null,
      ...sealed,
      phoneBlind: await this.codec.blind("address-phone", `${userId}|${phone}`),
      governorateCode: d.governorateCode,
      cityCode: d.cityDistrictCode,
      dedupeBlind: await this.codec.blind("address-dedupe", `${userId}|${key}`),
      courierCoverage: cov.coverage,
      codEligible: addresses.isCodEligible({ landmark: plain.landmark, mapPin: plain.mapPin, coverage: cov.coverage, codSupported: cov.codSupported }),
      qualityScore: addresses.addressQualityScore({
        recipientName: plain.recipientName,
        phoneE164: phone,
        governorateCode: d.governorateCode,
        cityDistrictCode: d.cityDistrictCode,
        street: plain.street,
        building: plain.building,
        floor: plain.floor,
        apartment: plain.apartment,
        landmark: plain.landmark,
        mapPin: plain.mapPin,
      }),
      isDefault: base.isDefault,
      createdAtMs: base.createdAtMs,
      updatedAtMs: nowMs,
    };
  }

  async create(userId: string, d: AddressInput): Promise<WriteOutcome> {
    const { errors, phone } = await this.validate(d);
    if (errors.length > 0 || phone === null) return { kind: "invalid", errors };
    const id = this.ids.uuidV7();
    const now = this.clock.nowMs();
    const row = await this.build(userId, id, d, phone, { isDefault: false, createdAtMs: now }, now);
    return this.store.run(userId, async (tx) => {
      const all = await tx.all();
      if (all.length >= addresses.MAX_ADDRESSES_PER_USER) return { kind: "limit_reached" } as const;
      if (all.some((a) => bytesEqual(a.dedupeBlind, row.dedupeBlind))) return { kind: "duplicate" } as const;
      const created = { ...row, isDefault: all.length === 0 };
      await tx.insert(created);
      return { kind: "ok", address: await this.codec.view(created) } as const;
    });
  }

  async update(userId: string, id: string, patch: AddressPatch): Promise<WriteOutcome> {
    const current = await this.store.find(userId, id);
    if (current === null) return { kind: "not_found" };
    const cur = await this.codec.view(current);
    const merged: AddressInput = {
      label: patch.label === undefined ? cur.label : (patch.label ?? undefined),
      recipientName: patch.recipientName ?? cur.recipientName,
      phone: patch.phone ?? cur.phoneE164,
      governorateCode: patch.governorateCode ?? cur.governorateCode,
      cityDistrictCode: patch.cityDistrictCode ?? cur.cityDistrictCode,
      street: patch.street ?? cur.street,
      building: patch.building ?? cur.building,
      floor: patch.floor === undefined ? cur.floor : (patch.floor ?? undefined),
      apartment: patch.apartment === undefined ? cur.apartment : (patch.apartment ?? undefined),
      landmark: patch.landmark === undefined ? cur.landmark : (patch.landmark ?? undefined),
      mapPin: patch.mapPin === undefined ? cur.mapPin : (patch.mapPin ?? undefined),
    };
    const { errors, phone } = await this.validate(merged);
    if (errors.length > 0 || phone === null) return { kind: "invalid", errors };
    const now = this.clock.nowMs();
    const next = await this.build(userId, id, merged, phone, { isDefault: cur.isDefault, createdAtMs: cur.createdAtMs }, now);
    return this.store.run(userId, async (tx) => {
      const existing = await tx.get(id);
      if (existing === null) return { kind: "not_found" } as const;
      const all = await tx.all();
      if (all.some((a) => a.id !== id && bytesEqual(a.dedupeBlind, next.dedupeBlind))) return { kind: "duplicate" } as const;
      const saved = { ...next, isDefault: existing.isDefault };
      await tx.update(saved);
      return { kind: "ok", address: await this.codec.view(saved) } as const;
    });
  }

  /** Deleting the default promotes the most recent remaining address. Snapshots are untouched. */
  async remove(userId: string, id: string): Promise<boolean> {
    return this.store.run(userId, async (tx) => {
      const all = await tx.all();
      if (!all.some((a) => a.id === id)) return false;
      const promote = addresses.promoteAfterDelete(all, id);
      await tx.remove(id);
      if (promote !== null) await setDefaultIn(tx, promote, this.clock.nowMs());
      return true;
    });
  }

  async setDefault(userId: string, id: string): Promise<AddressView | null> {
    const row = await this.store.run(userId, async (tx) => {
      if ((await tx.get(id)) === null) return null;
      return setDefaultIn(tx, id, this.clock.nowMs());
    });
    return row === null ? null : this.codec.view(row);
  }

  // ---- checkout: immutable delivery snapshots and gift tokens -------------------------------

  /**
   * Copies the address into an immutable, re-encrypted `delivery_snapshots` row for the order.
   * `addressRef` is a saved address id of the buyer, or a gift token (`gift_...`) whose owner's
   * address is copied WITHOUT ever being returned to the buyer. Idempotent on (buyer, orderRef).
   */
  async snapshotForOrder(buyerId: string, orderRef: string, addressRef: string): Promise<SnapshotOutcome> {
    let source: AddressRow | null;
    let gift = false;
    if (addressRef.startsWith(GIFT_TOKEN_PREFIX)) {
      const tok = await this.store.findGiftToken(hashToken(addressRef));
      if (tok === null || tok.revokedAtMs !== null || tok.expiresAtMs <= this.clock.nowMs()) return { kind: "not_found" };
      source = await this.store.find(tok.ownerUserId, tok.addressId);
      gift = true;
    } else {
      source = await this.store.find(buyerId, addressRef);
    }
    if (source === null) return { kind: "not_found" };
    if (source.courierCoverage === "not_covered") return { kind: "not_covered" };
    const id = this.ids.uuidV7();
    const plain = await this.codec.open("address", source.id, source);
    const sealed = await this.codec.seal("snapshot", id, plain);
    const stored = await this.store.insertSnapshot({
      id,
      userId: buyerId,
      orderRef,
      sourceAddressId: gift ? null : source.id,
      gift,
      ...sealed,
      governorateCode: source.governorateCode,
      cityCode: source.cityCode,
      courierCoverage: source.courierCoverage,
      // A recipient's COD flag says nothing about the buyer's payment: gifts are never COD.
      codEligible: gift ? false : source.codEligible,
      createdAtMs: this.clock.nowMs(),
    });
    return { kind: "ok", snapshot: summaryOf(stored) };
  }

  /** Courier-only read (fulfillment, system role): the decrypted snapshot. Never exposed to a buyer route. */
  async courierSnapshot(snapshotId: string): Promise<(PlainAddress & { governorateCode: string; cityCode: string; gift: boolean }) | null> {
    const row = await this.store.findSnapshot(snapshotId);
    if (row === null) return null;
    return { ...(await this.codec.openSnapshot(row)), governorateCode: row.governorateCode, cityCode: row.cityCode, gift: row.gift };
  }

  /** Owner issues a hidden-address token to share on a gift list. Returns the raw token ONCE; only its hash is stored. */
  async issueGiftToken(ownerId: string, addressId: string, ttlMs: number): Promise<{ token: string; expiresAtMs: number } | null> {
    if ((await this.store.find(ownerId, addressId)) === null) return null;
    const token = `${GIFT_TOKEN_PREFIX}${this.randomToken()}`;
    const expiresAtMs = this.clock.nowMs() + Math.min(Math.max(ttlMs, 60_000), GIFT_TTL_MAX_MS);
    await this.store.insertGiftToken({ tokenHash: hashToken(token), ownerUserId: ownerId, addressId, expiresAtMs, revokedAtMs: null });
    return { token, expiresAtMs };
  }

  async revokeGiftToken(ownerId: string, token: string): Promise<boolean> {
    return this.store.revokeGiftToken(ownerId, hashToken(token), this.clock.nowMs());
  }

  /** What a buyer may learn from a gift token: coverage of the destination, nothing else. */
  async giftDestination(token: string): Promise<{ governorateCode: string; courierCoverage: addresses.CourierCoverage } | null> {
    const tok = await this.store.findGiftToken(hashToken(token));
    if (tok === null || tok.revokedAtMs !== null || tok.expiresAtMs <= this.clock.nowMs()) return null;
    const src = await this.store.find(tok.ownerUserId, tok.addressId);
    return src === null ? null : { governorateCode: src.governorateCode, courierCoverage: src.courierCoverage };
  }
}

const summaryOf = (s: SnapshotRow): DeliverySnapshot => ({
  id: s.id,
  orderRef: s.orderRef,
  gift: s.gift,
  governorateCode: s.governorateCode,
  courierCoverage: s.courierCoverage,
  codEligible: s.codEligible,
});

const blankToUndef = (v: string | undefined | null): string | undefined => (v === undefined || v === null || v.trim() === "" ? undefined : v.trim());

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Unsets the previous default BEFORE setting the new one (the partial unique index allows one). */
async function setDefaultIn(tx: AddressTx, id: string, nowMs: number): Promise<AddressRow> {
  const all = await tx.all();
  let target: AddressRow | null = null;
  for (const a of all) if (a.isDefault && a.id !== id) await tx.update({ ...a, isDefault: false, updatedAtMs: nowMs });
  for (const a of all) if (a.id === id) target = { ...a, isDefault: true, updatedAtMs: a.isDefault ? a.updatedAtMs : nowMs };
  if (target === null) throw new Error("address vanished inside its own transaction");
  if (!all.find((a) => a.id === id)?.isDefault) await tx.update(target);
  return target;
}
