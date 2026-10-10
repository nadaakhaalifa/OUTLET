/**
 * DEVELOPMENT FIXTURES: per-process repository, event sink, membership and platform config.
 * Not safe for production (the module refuses to start with real adapters configured).
 */
import type { Actor, Resource } from "@outlet/policy";
import type { Money } from "../domain/bridge";
import type {
  CartEventPublisher,
  CartRecord,
  CartRepository,
  LineUnavailableEvent,
  MembershipPort,
  PlatformConfigPort,
} from "../domain/ports";
import { money } from "../domain/bridge";

export class InMemoryCartRepository implements CartRepository {
  private readonly byUser = new Map<string, CartRecord>();

  async getOrCreate(userId: string, newId: string, nowMs: number): Promise<CartRecord> {
    let c = this.byUser.get(userId);
    if (c === undefined) {
      c = { id: newId, userId, version: 0, updatedAtMs: nowMs, lines: [] };
      this.byUser.set(userId, c);
    }
    return c;
  }

  async save(cart: CartRecord, expectedVersion: number, nowMs: number): Promise<boolean> {
    const current = this.byUser.get(cart.userId);
    if (current === undefined || current.version !== expectedVersion) return false;
    this.byUser.set(cart.userId, { ...cart, version: expectedVersion + 1, updatedAtMs: nowMs });
    return true;
  }

  async setUnavailableSince(
    userId: string,
    changes: readonly { readonly lineId: string; readonly sinceMs: number | null }[],
  ): Promise<void> {
    const c = this.byUser.get(userId);
    if (c === undefined) return;
    const by = new Map(changes.map((x) => [x.lineId, x.sinceMs]));
    this.byUser.set(userId, {
      ...c,
      lines: c.lines.map((l) => (by.has(l.id) ? { ...l, unavailableSinceMs: by.get(l.id) ?? null } : l)),
    });
  }

  async findLineOwner(lineId: string): Promise<string | null> {
    for (const c of this.byUser.values()) if (c.lines.some((l) => l.id === lineId)) return c.userId;
    return null;
  }

  /** Test helper: simulate a concurrent write from another device. */
  bumpVersionForTest(userId: string): void {
    const c = this.byUser.get(userId);
    if (c !== undefined) this.byUser.set(userId, { ...c, version: c.version + 1 });
  }
}

export class InMemoryCartEventPublisher implements CartEventPublisher {
  readonly events: LineUnavailableEvent[] = [];
  async publish(event: LineUnavailableEvent): Promise<void> {
    this.events.push(event);
  }
}

export class StaticMembership implements MembershipPort {
  private readonly plus = new Set<string>();
  grant(userId: string): void {
    this.plus.add(userId);
  }
  revoke(userId: string): void {
    this.plus.delete(userId);
  }
  async isPlusMember(userId: string): Promise<boolean> {
    return this.plus.has(userId);
  }
}

export class StaticPlatformConfig implements PlatformConfigPort {
  constructor(private threshold: Money = money(200_000n)) {}
  set(threshold: Money): void {
    this.threshold = threshold;
  }
  async freeDeliveryThreshold(): Promise<Money> {
    return this.threshold;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Returns the true owner so `decide()` yields 404 for foreign and missing ids alike. */
export class CartLineResolver {
  constructor(private readonly repo: CartRepository) {}

  async resolve(input: { readonly id: string | undefined; readonly actor: Actor }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const owner = await this.repo.findLineOwner(input.id);
    if (owner === null) return null;
    return { type: "cart", id: input.id, ownerUserId: owner, state: "active" };
  }
}
