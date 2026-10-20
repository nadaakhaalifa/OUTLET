import { ApiAutoBuyPort } from "../features/auto-buy/api";
import { ApiBagPort } from "../features/bag/api";
import { ApiBudgetPort } from "../features/budget/api";
import { FakeMapPin, FakePaymentLauncher } from "../features/checkout/model";
import { ApiCheckoutPort } from "../features/checkout/api";
import { ApiAddressesPort } from "../features/checkout/addresses-api";
import { ApiDropsPort } from "../features/drops/api";
import { ApiFamilyPort } from "../features/family/api";
import { ApiGiftCardsPort } from "../features/gift-cards/api";
import { ApiOrdersPort } from "../features/orders/api";
import { ApiHomePort } from "../features/home/api";
import { ApiHomeBannersPort } from "../features/home-banners/api";
import { ApiPdpPort } from "../features/pdp/api";
import { ApiPlusPort } from "../features/plus/api";
import { ApiPrivacyPort } from "../features/privacy-center/api";
import { ExpoPhotoPicker } from "../features/returns/image-picker";
import { FakePhotoUpload } from "../features/returns/model";
import { ApiReturnsPort } from "../features/returns/api";
import { ApiRewardsPort } from "../features/rewards/api";
import { ApiSearchPort } from "../features/search/api";
import { ApiSizeProfilePort } from "../features/size-profile/api";
import { ApiStylistPort } from "../features/stylist/api";
import { ApiCalendarPort } from "../features/outfit-calendar/api";
import { ApiStylistChatPort } from "../features/stylist-chat/api";
import { ApiWardrobePort } from "../features/wardrobe/api";
import { ApiVisualSearchPort } from "../features/visual-search/api";
import { ApiWalletPort } from "../features/wallet/api";
import { ApiWishlistsPort } from "../features/wishlists/api";
import { ApiCategoryPort } from "../features/shop-all/api";
import { ApiWorldsPort } from "../features/worlds/api";
import type { FeaturePorts } from "../state/feature-ports";
import type { AdapterContext } from "./wire";

/**
 * Real, API-backed ports. Device-bound ports (payment sheet launcher, map pin picker, photo picker) are not
 * API calls; they stay as the in-app fakes until the native modules land. See docs/engineering/api-client.md.
 */
export function createApiPorts(ctx: AdapterContext): FeaturePorts {
  const bag = new ApiBagPort(ctx);
  const wishlists = new ApiWishlistsPort(ctx);
  const sizeProfile = new ApiSizeProfilePort(ctx);
  const stylist = new ApiStylistPort(ctx);
  return {
    worlds: new ApiWorldsPort(ctx),
    categories: new ApiCategoryPort(ctx),
    search: new ApiSearchPort(ctx),
    pdp: new ApiPdpPort(ctx, bag, wishlists, sizeProfile),
    bag,
    wishlists,
    sizeProfile,
    checkout: new ApiCheckoutPort(ctx),
    paymentLauncher: new FakePaymentLauncher(),
    mapPin: new FakeMapPin(),
    addresses: new ApiAddressesPort(ctx),
    orders: new ApiOrdersPort(ctx),
    returns: new ApiReturnsPort(ctx),
    photos: new ExpoPhotoPicker(),
    // No signed-upload operation for shoppers exists yet (docs/plan/api-client-gap.md): uploads stay on-device fakes.
    photoUploads: new FakePhotoUpload(),
    privacy: new ApiPrivacyPort(ctx),
    plus: new ApiPlusPort(ctx),
    wallet: new ApiWalletPort(ctx),
    giftCards: new ApiGiftCardsPort(ctx),
    stylist,
    // The server writes accepted outfit items into the bag itself, so no BagBackedStylist wrapper here.
    outfitBag: stylist,
    budget: new ApiBudgetPort(ctx),
    rewards: new ApiRewardsPort(ctx),
    drops: new ApiDropsPort(ctx),
    home: new ApiHomePort(ctx),
    homeBanners: new ApiHomeBannersPort(ctx),
    visualSearch: new ApiVisualSearchPort(ctx),
    autoBuy: new ApiAutoBuyPort(ctx),
    family: new ApiFamilyPort(ctx),
    stylistChat: new ApiStylistChatPort(ctx),
    calendar: new ApiCalendarPort(ctx),
    wardrobe: new ApiWardrobePort(ctx),
  };
}
