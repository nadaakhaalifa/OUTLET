/**
 * One container for every feature port. Screens read their port from here (a `port` prop still wins,
 * for tests), so cross-feature flows share state: PDP -> Bag, PDP -> Wishlists, Stylist -> Bag.
 * With EXPO_PUBLIC_API_BASE_URL set the container defaults to the real API adapters (services/api-ports.ts);
 * without it the in-memory fakes are used in development and tests only; release builds throw BackendNotConfiguredError. `setFeaturePorts` still overrides both.
 */
import { InMemoryAutoBuyPort } from "../features/auto-buy/model";
import { InMemoryBagPort, type BagPort } from "../features/bag/model";
import { InMemoryBudgetPort } from "../features/budget/model";
import { InMemoryAddressesPort, InMemoryCheckoutPort, FakeMapPin, FakePaymentLauncher } from "../features/checkout/model";
import { InMemoryDropsPort } from "../features/drops/model";
import { InMemoryHomePort } from "../features/home/model";
import { InMemoryHomeBannersPort } from "../features/home-banners/model";
import { InMemoryFamilyPort } from "../features/family/model";
import { InMemoryGiftCardsPort } from "../features/gift-cards/model";
import { InMemoryOrdersPort } from "../features/orders/model";
import { InMemoryPdpPort } from "../features/pdp/model";
import { InMemoryPlusPort } from "../features/plus/model";
import { InMemoryPrivacyPort } from "../features/privacy-center/model";
import { ExpoPhotoPicker } from "../features/returns/image-picker";
import { InMemoryReturnsPort, FakePhotoUpload } from "../features/returns/model";
import { InMemoryRewardsPort } from "../features/rewards/model";
import { BOARD_SEARCH_ROWS, FIXTURE_SEARCH_ROWS, InMemorySearchPort } from "../features/search/model";
import { InMemorySizeProfilePort } from "../features/size-profile/model";
import {
  InMemoryStylistPort, type AddOutfitResult, type FeedbackSignal, type Outfit, type OutfitBagPort, type OutfitRequest, type OutfitResult, type StylistPort,
} from "../features/stylist/model";
import { InMemoryVisualSearchPort } from "../features/visual-search/model";
import { InMemoryWalletPort } from "../features/wallet/model";
import { InMemoryWishlistsPort } from "../features/wishlists/model";
import { InMemoryCategoryPort } from "../features/shop-all/model";
import { FIXTURE_STORES, InMemoryWorldsPort } from "../features/worlds/model";
import { generateDevCatalog, generateDevStores } from "../features/search/dev-catalog";
import { InMemoryCalendarPort } from "../features/outfit-calendar/model";
import { InMemoryChatPort } from "../features/stylist-chat/model";
import { InMemoryWardrobePort } from "../features/wardrobe/model";
import type { FeaturePorts } from "./feature-ports";
import i18next from "i18next";
import { ApiMergeTransport, GuestStore, SqliteGuestStorage, newMergeKey, runGuestMerge, withGuestStore, type GuestStorePort } from "../features/guest";
import { GuestWishlistsPort } from "../features/wishlists/guest-wishlists";
import { ApiSavedProductReader } from "../features/wishlists/guest-wishlists-api";
import { SessionWishlistsPort } from "../features/wishlists/session-wishlists";
import { GuestBagPort } from "../features/bag/guest-bag";
import { ApiSkuLiveReader } from "../features/bag/guest-bag-api";
import { SessionBagPort } from "../features/bag/session-bag";
import { createApiPorts } from "../services/api-ports";
import { apiBaseUrlFromEnv, createAdapterContext, getApiRuntime, getSharedClient } from "../services/runtime";
import { registerDevHint } from "../services/dev-hints";
import { BackendNotConfiguredError, currentBackendConfig } from "../services/release-guard";

export type { FeaturePorts };

/**
 * Generates and validates outfits with the stylist port, then writes every accepted item through
 * the Bag port, so the bag tab shows exactly what the outfit added.
 */
export class BagBackedStylist implements StylistPort, OutfitBagPort {
  private readonly known = new Map<string, Outfit>();
  constructor(private readonly inner: StylistPort & OutfitBagPort, private readonly bag: BagPort) {}
  private remember(o: Outfit): void {
    this.known.set(o.id, o);
  }
  async generate(req: OutfitRequest): Promise<OutfitResult> {
    const r = await this.inner.generate(req);
    r.outfits.forEach((o) => this.remember(o));
    return r;
  }
  async swap(outfitId: string, skuId: string): Promise<Outfit> {
    const o = await this.inner.swap(outfitId, skuId);
    this.remember(o);
    return o;
  }
  feedback(outfitId: string, skuId: string, signal: FeedbackSignal): Promise<void> {
    return this.inner.feedback(outfitId, skuId, signal);
  }
  async addOutfit(outfitId: string, idempotencyKey: string): Promise<AddOutfitResult> {
    const verdict = await this.inner.addOutfit(outfitId, idempotencyKey);
    const outfit = this.known.get(outfitId);
    const accepted = new Set(verdict.added);
    for (const i of outfit?.items ?? []) {
      if (!accepted.has(i.skuId)) continue;
      await this.bag.addLine(i.skuId, { storeId: i.storeId, storeName: i.storeName, title: i.title, sizeLabel: i.sizeLabel, unitPrice: i.unitPrice });
    }
    return verdict;
  }
}

/** Long synthetic catalogue and stores for scroll/pagination testing. Empty outside __DEV__ (and under vitest, where __DEV__ is undefined). */
const demoCatalog = typeof __DEV__ !== "undefined" && __DEV__ ? generateDevCatalog() : [];

export function createInMemoryPorts(): FeaturePorts {
  const bag = new InMemoryBagPort();
  const stylist = new BagBackedStylist(new InMemoryStylistPort(), bag);
  return {
    worlds: new InMemoryWorldsPort([...FIXTURE_STORES, ...(demoCatalog.length > 0 ? generateDevStores(demoCatalog) : [])]),
    categories: new InMemoryCategoryPort(),
    search: new InMemorySearchPort([...FIXTURE_SEARCH_ROWS, ...BOARD_SEARCH_ROWS, ...demoCatalog]),
    pdp: new InMemoryPdpPort(),
    bag,
    wishlists: new InMemoryWishlistsPort(),
    sizeProfile: new InMemorySizeProfilePort(),
    checkout: new InMemoryCheckoutPort(),
    paymentLauncher: new FakePaymentLauncher(),
    mapPin: new FakeMapPin(),
    addresses: new InMemoryAddressesPort(),
    orders: new InMemoryOrdersPort(),
    returns: new InMemoryReturnsPort(),
    photos: new ExpoPhotoPicker(),
    photoUploads: new FakePhotoUpload(),
    privacy: new InMemoryPrivacyPort(),
    plus: new InMemoryPlusPort(),
    wallet: new InMemoryWalletPort(),
    giftCards: new InMemoryGiftCardsPort(),
    stylist,
    outfitBag: stylist,
    budget: new InMemoryBudgetPort(),
    rewards: new InMemoryRewardsPort(),
    drops: new InMemoryDropsPort(),
    home: new InMemoryHomePort(),
    homeBanners: new InMemoryHomeBannersPort(),
    visualSearch: new InMemoryVisualSearchPort(),
    autoBuy: new InMemoryAutoBuyPort(),
    family: new InMemoryFamilyPort(),
    stylistChat: new InMemoryChatPort(),
    calendar: new InMemoryCalendarPort(),
    wardrobe: new InMemoryWardrobePort(),
  };
}

let current: FeaturePorts | null = null;

/**
 * Real adapters when an API base URL is configured, in-memory fakes otherwise. A configured URL without a
 * registered runtime is a wiring bug and fails loudly: it must never fall back to fake data silently.
 */
export function createDefaultPorts(baseUrl: string | null = apiBaseUrlFromEnv()): FeaturePorts {
  const cfg = currentBackendConfig(baseUrl);
  // Release builds never fall back to fixtures: the root layout shows the "not configured" screen first.
  if (cfg.kind === "blocked") throw new BackendNotConfiguredError(cfg.reason);
  if (cfg.kind === "fixture") {
    registerDevHint("backend", "No backend URL is set: every feature runs on in-memory fakes. Nothing is sent anywhere and no data is real.");
    return createInMemoryPorts();
  }
  const runtime = getApiRuntime();
  if (runtime === null) throw new Error("EXPO_PUBLIC_API_BASE_URL is set but configureApiRuntime() has not run (see services/runtime.ts)");
  const store = getGuestStore();
  // The context carries `isGuest` (token read) and the device store's signals: public adapters switch to /v1/public/* by themselves.
  const ctx = withGuestStore(createAdapterContext(runtime), store);
  const ports = createApiPorts(ctx);
  // Signed out: the Bag reads this phone's guest store (ADR-0055). Signed in: the server bag, after any pending merge.
  // (The PDP port still holds the server bag; the guest add-to-bag path on the PDP belongs to G4.)
  const client = getSharedClient(runtime);
  const guestBag = new GuestBagPort(store, new ApiSkuLiveReader(client));
  const signedIn = async (): Promise<boolean> => (await runtime.tokens.load()) !== null;
  const bag = new SessionBagPort(
    ports.bag,
    guestBag,
    signedIn,
    async () => { await runGuestMerge({ store, transport: new ApiMergeTransport(client), newKey: newMergeKey, includeViewed: false }); },
  );
  // Saved: the server lists when signed in, this phone's lists when signed out (device store, public product reads, guest bag).
  const wishlists = new SessionWishlistsPort(
    ports.wishlists,
    new GuestWishlistsPort(store, guestBag, new ApiSavedProductReader(client, ctx), (i) => i18next.t(`wishlists.intent.${i}`)),
    signedIn,
  );
  return { ...ports, bag, wishlists };
}

/** The process-wide container, created lazily (real adapters or fakes, see createDefaultPorts). */
export function getFeaturePorts(): FeaturePorts {
  if (current === null) current = createDefaultPorts();
  return current;
}

/** Swap in a real API-backed container (call once at startup, before rendering). */
export function setFeaturePorts(p: FeaturePorts | null): void {
  current = p;
}

let guest: GuestStorePort | null = null;

/** Device-only guest store (ADR-0055), created lazily on expo-sqlite. Not part of FeaturePorts: it never talks to the API. */
export function getGuestStore(): GuestStorePort {
  if (guest === null) guest = new GuestStore(new SqliteGuestStorage());
  return guest;
}

/** Tests and the dev-client MMKV swap-in. */
export function setGuestStore(g: GuestStorePort | null): void {
  guest = g;
}
