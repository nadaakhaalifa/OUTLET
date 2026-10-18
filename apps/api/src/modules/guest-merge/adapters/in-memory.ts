/**
 * DEVELOPMENT / TEST FIXTURES. Never production: the module refuses to boot in production without a real
 * (Postgres) unit of work. The in-memory unit of work cannot roll back; it serialises calls and relies on the
 * merge writing the cart first (compare-and-set), so a lost race writes nothing.
 */
import type { CartRepository } from "../../cart";
import type { WishlistRepository } from "../../wishlists";
import type {
  GuestMergedEvent,
  GuestMergeUnitOfWork,
  MergeTx,
  PersonalizationConsentReader,
  RecentlyViewedWriter,
} from "../domain/ports";

export class InMemoryGuestMergeUnitOfWork implements GuestMergeUnitOfWork {
  readonly events: GuestMergedEvent[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cart: () => CartRepository,
    private readonly wishlists: () => WishlistRepository,
  ) {}

  run<T>(_userId: string, fn: (tx: MergeTx) => Promise<T>): Promise<T> {
    const tx: MergeTx = {
      cart: this.cart(),
      wishlists: this.wishlists(),
      emit: async (e) => {
        this.events.push(e);
      },
    };
    const next = this.chain.then(() => fn(tx));
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export class StaticPersonalizationConsent implements PersonalizationConsentReader {
  private readonly granted = new Set<string>();
  grant(userId: string): void {
    this.granted.add(userId);
  }
  revoke(userId: string): void {
    this.granted.delete(userId);
  }
  async isGranted(userId: string): Promise<boolean> {
    return this.granted.has(userId);
  }
}

export class InMemoryRecentlyViewedWriter implements RecentlyViewedWriter {
  readonly recorded: { userId: string; productIds: readonly string[] }[] = [];
  async record(userId: string, productIds: readonly string[]): Promise<void> {
    this.recorded.push({ userId, productIds });
  }
}
