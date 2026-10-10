export const WISHLIST_REPOSITORY = Symbol("wishlists.WishlistRepository");
export const WISHLIST_CATALOG = Symbol("wishlists.CatalogReadPort");
export const WISHLIST_OWNER_PROFILES = Symbol("wishlists.OwnerProfilePort");
export const WISHLIST_EVENTS = Symbol("wishlists.WishlistEventPublisher");
export const WISHLIST_RESOLVER = Symbol("wishlists.ResourceResolver");

export const CREATE_WISHLIST = Symbol("wishlists.CreateWishlist");
export const LIST_WISHLISTS = Symbol("wishlists.ListWishlists");
export const WISHLIST_DETAILS = Symbol("wishlists.WishlistDetails");
export const UPDATE_WISHLIST = Symbol("wishlists.UpdateWishlist");
export const DELETE_WISHLIST = Symbol("wishlists.DeleteWishlist");
export const ADD_WISHLIST_ITEM = Symbol("wishlists.AddWishlistItem");
export const REMOVE_WISHLIST_ITEM = Symbol("wishlists.RemoveWishlistItem");
export const CREATE_SHARE_LINK = Symbol("wishlists.CreateShareLink");
export const REVOKE_SHARE_LINK = Symbol("wishlists.RevokeShareLink");
export const GET_SHARED_WISHLIST = Symbol("wishlists.GetSharedWishlist");
export const HANDLE_CATALOG_SIGNAL = Symbol("wishlists.HandleCatalogSignal");
export const SCHEDULE_DATE_ALERTS = Symbol("wishlists.ScheduleDateAlerts");
