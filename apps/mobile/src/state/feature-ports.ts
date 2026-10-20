/** Type-only contract for the feature port container (kept apart from ports.ts so adapters can depend on it without a cycle). */
import type { AutoBuyPort } from "../features/auto-buy/model";
import type { BagPort } from "../features/bag/model";
import type { BudgetPort } from "../features/budget/model";
import type { AddressesPort, CheckoutPort, MapPinPort, PaymentLauncherPort } from "../features/checkout/model";
import type { DropsPort } from "../features/drops/model";
import type { HomePort } from "../features/home/model";
import type { HomeBannersPort } from "../features/home-banners/model";
import type { FamilyPort } from "../features/family/model";
import type { GiftCardsPort } from "../features/gift-cards/model";
import type { OrdersPort } from "../features/orders/model";
import type { CalendarPort } from "../features/outfit-calendar/model";
import type { PdpPort } from "../features/pdp/model";
import type { PlusPort } from "../features/plus/model";
import type { PrivacyPort } from "../features/privacy-center/model";
import type { PhotoPickerPort, PhotoUploadPort, ReturnsPort } from "../features/returns/model";
import type { RewardsPort } from "../features/rewards/model";
import type { SearchPort } from "../features/search/model";
import type { SizeProfilePort } from "../features/size-profile/model";
import type { OutfitBagPort, StylistPort } from "../features/stylist/model";
import type { ChatPort } from "../features/stylist-chat/model";
import type { WardrobePort } from "../features/wardrobe/model";
import type { VisualSearchPort } from "../features/visual-search/model";
import type { WalletPort } from "../features/wallet/model";
import type { WishlistsPort } from "../features/wishlists/model";
import type { CategoryPort } from "../features/shop-all/model";
import type { WorldsPort } from "../features/worlds/model";

export interface FeaturePorts {
  readonly worlds: WorldsPort;
  /** Public category tree for Shop everything (GET /v1/public/categories). */
  readonly categories: CategoryPort;
  readonly search: SearchPort;
  readonly pdp: PdpPort;
  readonly bag: BagPort;
  readonly wishlists: WishlistsPort;
  readonly sizeProfile: SizeProfilePort;
  readonly checkout: CheckoutPort;
  readonly paymentLauncher: PaymentLauncherPort;
  readonly mapPin: MapPinPort;
  readonly addresses: AddressesPort;
  readonly orders: OrdersPort;
  readonly returns: ReturnsPort;
  readonly photos: PhotoPickerPort;
  readonly photoUploads: PhotoUploadPort;
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
  readonly home: HomePort;
  readonly homeBanners: HomeBannersPort;
  /** Phase 3 wave C part 2. */
  readonly visualSearch: VisualSearchPort;
  readonly autoBuy: AutoBuyPort;
  readonly family: FamilyPort;
  /** Phase 3 wave C part 1. */
  readonly stylistChat: ChatPort;
  readonly calendar: CalendarPort;
  readonly wardrobe: WardrobePort;
}
