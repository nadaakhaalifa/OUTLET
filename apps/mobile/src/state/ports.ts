/**
 * One container for every feature port. Screens read their port from here (a `port` prop still wins,
 * for tests), so cross-feature flows share state: PDP -> Bag, PDP -> Wishlists, Stylist -> Bag.
 * Development uses the in-memory fakes; a real API client swaps in with `setFeaturePorts` before
 * the first render, without touching any screen.
 */
import { InMemoryBagPort, type BagPort } from "../features/bag/model";
import { InMemoryBudgetPort, type BudgetPort } from "../features/budget/model";
import { InMemoryCheckoutPort, FakeMapPin, FakePaymentLauncher, type CheckoutPort, type MapPinPort, type PaymentLauncherPort } from "../features/checkout/model";
import { InMemoryDropsPort, type DropsPort } from "../features/drops/model";
import { InMemoryGiftCardsPort, type GiftCardsPort } from "../features/gift-cards/model";
import { InMemoryOrdersPort, type OrdersPort } from "../features/orders/model";
import { InMemoryPdpPort, type PdpPort } from "../features/pdp/model";
import { InMemoryPlusPort, type PlusPort } from "../features/plus/model";
import { InMemoryPrivacyPort, type PrivacyPort } from "../features/privacy-center/model";
import { InMemoryReturnsPort, FakePhotoPicker, type PhotoPickerPort, type ReturnsPort } from "../features/returns/model";
import { InMemoryRewardsPort, type RewardsPort } from "../features/rewards/model";
import { InMemorySearchPort, type SearchPort } from "../features/search/model";
import { InMemorySizeProfilePort, type SizeProfilePort } from "../features/size-profile/model";
import {
  InMemoryStylistPort, type AddOutfitResult, type FeedbackSignal, type Outfit, type OutfitBagPort, type OutfitRequest, type OutfitResult, type StylistPort,
} from "../features/stylist/model";
import { InMemoryWalletPort, type WalletPort } from "../features/wallet/model";
import { InMemoryWishlistsPort, type WishlistsPort } from "../features/wishlists/model";
import { InMemoryWorldsPort, type WorldsPort } from "../features/worlds/model";

export interface FeaturePorts {
  readonly worlds: WorldsPort;
  readonly search: SearchPort;
  readonly pdp: PdpPort;
  readonly bag: BagPort;
  readonly wishlists: WishlistsPort;
  readonly sizeProfile: SizeProfilePort;
  readonly checkout: CheckoutPort;
  readonly paymentLauncher: PaymentLauncherPort;
  readonly mapPin: MapPinPort;
  readonly orders: OrdersPort;
  readonly returns: ReturnsPort;
  readonly photos: PhotoPickerPort;
  readonly privacy: PrivacyPort;
  readonly plus: PlusPort;
  readonly wallet: WalletPort;
  readonly giftCards: GiftCardsPort;
  readonly stylist: StylistPort;
  /** Adds an outfit through the real Bag port. */
  readonly outfitBag: OutfitBagPort;
  readonly budget: BudgetPort;
  readonly rewards: RewardsPort;
  readonly drops: DropsPort;
}

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

export function createInMemoryPorts(): FeaturePorts {
  const bag = new InMemoryBagPort();
  const stylist = new BagBackedStylist(new InMemoryStylistPort(), bag);
  return {
    worlds: new InMemoryWorldsPort(),
    search: new InMemorySearchPort(),
    pdp: new InMemoryPdpPort(),
    bag,
    wishlists: new InMemoryWishlistsPort(),
    sizeProfile: new InMemorySizeProfilePort(),
    checkout: new InMemoryCheckoutPort(),
    paymentLauncher: new FakePaymentLauncher(),
    mapPin: new FakeMapPin(),
    orders: new InMemoryOrdersPort(),
    returns: new InMemoryReturnsPort(),
    photos: new FakePhotoPicker(),
    privacy: new InMemoryPrivacyPort(),
    plus: new InMemoryPlusPort(),
    wallet: new InMemoryWalletPort(),
    giftCards: new InMemoryGiftCardsPort(),
    stylist,
    outfitBag: stylist,
    budget: new InMemoryBudgetPort(),
    rewards: new InMemoryRewardsPort(),
    drops: new InMemoryDropsPort(),
  };
}

let current: FeaturePorts | null = null;

/** The process-wide container. Created lazily from the in-memory fakes. */
export function getFeaturePorts(): FeaturePorts {
  if (current === null) current = createInMemoryPorts();
  return current;
}

/** Swap in a real API-backed container (call once at startup, before rendering). */
export function setFeaturePorts(p: FeaturePorts | null): void {
  current = p;
}
