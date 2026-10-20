import { Logger, Module, type DynamicModule } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CART_CATALOG, CART_PLATFORM_CONFIG, CART_REPOSITORY, GET_CART, type CatalogPort, type GetCart, type PlatformConfigPort } from "../cart";
import type { CartRepository } from "../cart";
import { HISTORY_CONSENT, RECORD_PRODUCT_VIEW } from "../history";
import { WISHLIST_CATALOG, WISHLIST_REPOSITORY, type CatalogReadPort, type WishlistRepository } from "../wishlists";
import { GuestMergeController } from "./adapters/guest-merge.controller";
import { InMemoryGuestMergeUnitOfWork } from "./adapters/in-memory";
import { GUEST_MERGE_UOW, MERGE_GUEST } from "./adapters/tokens";
import { MergeGuest } from "./application/merge-guest";
import type {
  GuestMergeUnitOfWork,
  PersonalizationConsentReader,
  RecentlyViewedWriter,
} from "./domain/ports";

export interface GuestMergeModuleOverrides {
  /** Production: KyselyGuestMergeUnitOfWork. Without it production fails closed at boot. */
  readonly uow?: GuestMergeUnitOfWork;
  /** Tests only: replace the late-bound consent reader / viewed writer. Otherwise the history module's ports are used. */
  readonly consent?: PersonalizationConsentReader;
  readonly viewed?: RecentlyViewedWriter;
}

/** Reads a port that another module owns, at call time (the module graph is complete by then). */
type Resolve = <T>(token: symbol) => T;

/**
 * Guest browsing, sign-in at checkout (ADR-0055, spec guest-browsing G-1): `POST /v1/me/guest-merge`.
 * Dark: behind `flag.guest_browsing` (platform GUEST_BROWSING_GATE, blocked by default). The catalog, platform config, wishlists catalog and
 * history ports are the modules' own (resolved late); only the unit of work needs a production binding.
 */
@Module({})
export class GuestMergeModule {
  static forRoot(config: AppConfig, overrides: GuestMergeModuleOverrides = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && overrides.uow === undefined) throw new NoProductionAdaptersError();
    return {
      module: GuestMergeModule,
      controllers: [GuestMergeController],
      providers: [
        {
          provide: GUEST_MERGE_UOW,
          inject: [ModuleRef],
          useFactory: (ref: ModuleRef): GuestMergeUnitOfWork => {
            const get: Resolve = <T,>(token: symbol): T => ref.get<unknown, T>(token, { strict: false });
            return (
              overrides.uow ??
              new InMemoryGuestMergeUnitOfWork(
                () => get<CartRepository>(CART_REPOSITORY),
                () => get<WishlistRepository>(WISHLIST_REPOSITORY),
              )
            );
          },
        },
        {
          provide: MERGE_GUEST,
          inject: [ModuleRef, GUEST_MERGE_UOW, CLOCK, ID_GENERATOR],
          useFactory: (ref: ModuleRef, uow: GuestMergeUnitOfWork, clock: Clock, ids: IdGenerator): MergeGuest => {
            const get: Resolve = <T,>(token: symbol): T => ref.get<unknown, T>(token, { strict: false });
            return new MergeGuest({
              uow,
              catalog: () => get<CatalogPort>(CART_CATALOG),
              platform: () => get<PlatformConfigPort>(CART_PLATFORM_CONFIG),
              products: () => get<CatalogReadPort>(WISHLIST_CATALOG),
              readCart: (userId) => get<GetCart>(GET_CART).execute(userId),
              consent: () => overrides.consent ?? get<PersonalizationConsentReader>(HISTORY_CONSENT),
              viewed: () =>
                overrides.viewed ?? {
                  record: async (userId, productIds) => {
                    const view = get<{ execute(userId: string, productId: string): Promise<unknown> }>(RECORD_PRODUCT_VIEW);
                    // Sequential on purpose: each execute upserts one history row; the request schema caps the list
                    // (at most 100) and the recorder is idempotent per product, so a batch API would add no safety.
                    for (const id of productIds) await view.execute(userId, id);
                  },
                },
              clock,
              ids,
              onPrefetchError: (cause) => {
                new Logger("GuestMerge").warn(`catalog prefetch failed: ${cause instanceof Error ? cause.message : "unknown"}`);
              },
            });
          },
        },
      ],
    };
  }
}
