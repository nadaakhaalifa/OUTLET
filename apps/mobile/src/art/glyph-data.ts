// Monoline illustration + category icon path data (pure). Illustrations: 96 box, 2px ink stroke, one gold accent.

export interface MonolineDef {
  readonly ink: readonly string[];
  readonly gold: readonly string[];
}

const circle = (cx: number, cy: number, r: number): string => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;

export const ILLUSTRATION_NAMES = [
  "emptyBag", "emptyWishlist", "noOrders", "noResults", "offline", "error", "success",
  "emptyWallet", "measureTape", "giftBox", "deliveryTruck", "returnBox", "privacyShield", "stylistSparkle",
] as const;
export type IllustrationName = (typeof ILLUSTRATION_NAMES)[number];

const BOX_OUTLINE = "M20 34L48 22L76 34V64L48 76L20 64Z";

export const ILLUSTRATIONS: Record<IllustrationName, MonolineDef> = {
  emptyBag: { ink: ["M24 36H72L76 80H20Z", "M36 36V28A12 12 0 0 1 60 28V36"], gold: ["M72 14V28M65 21H79"] },
  emptyWishlist: {
    ink: ["M48 80C20 60 16 38 30 30C38 26 45 30 48 38C51 30 58 26 66 30C80 38 76 60 48 80Z"],
    gold: ["M72 12L74 18L80 20L74 22L72 28L70 22L64 20L70 18Z"],
  },
  noOrders: { ink: [BOX_OUTLINE, "M20 34L48 46L76 34", "M48 46V76"], gold: ["M34 28L62 40"] },
  noResults: { ink: [circle(40, 40, 22), "M56 56L78 78"], gold: ["M33 33L47 47M47 33L33 47"] },
  offline: { ink: ["M14 38A48 48 0 0 1 82 38", "M25 50A32 32 0 0 1 71 50", "M36 62A16 16 0 0 1 60 62", "M48 74H48.1"], gold: ["M18 16L78 80"] },
  error: { ink: ["M48 16L84 78H12Z"], gold: ["M48 38V56M48 67H48.1"] },
  success: { ink: [circle(48, 48, 32)], gold: ["M34 49L44 59L63 38"] },
  emptyWallet: { ink: ["M16 32H74A6 6 0 0 1 80 38V70A6 6 0 0 1 74 76H22A6 6 0 0 1 16 70Z", "M16 32L56 18L66 32"], gold: ["M80 46H64V62H80M70 54H70.1"] },
  measureTape: { ink: ["M10 58L56 12L84 40L38 86Z", "M26 42L32 48M34 34L40 40M42 26L48 32", "M50 56L56 62"], gold: ["M58 36L62 40"] },
  giftBox: { ink: ["M18 44H78V82H18Z", "M14 32H82V44H14Z", "M48 32V82"], gold: ["M48 32C36 12 22 22 36 32M48 32C60 12 74 22 60 32"] },
  deliveryTruck: {
    ink: ["M10 30H56V66H10Z", "M56 42H74L86 54V66H56Z", circle(28, 70, 7), circle(70, 70, 7)],
    gold: ["M18 42H38M18 52H30"],
  },
  returnBox: { ink: [BOX_OUTLINE, "M20 34L48 46L76 34", "M48 46V76"], gold: ["M62 14H74A8 8 0 0 1 82 22V26M62 14L68 8M62 14L68 20"] },
  privacyShield: { ink: ["M48 12L78 24V46C78 64 64 76 48 84C32 76 18 64 18 46V24Z"], gold: ["M35 48L45 58L62 38"] },
  stylistSparkle: {
    ink: ["M44 16C46 38 54 46 76 52C54 58 46 66 44 88C42 66 34 58 12 52C34 46 42 38 44 16Z"],
    gold: ["M76 12C77 18 80 21 86 22C80 23 77 26 76 32C75 26 72 23 66 22C72 21 75 18 76 12Z"],
  },
};

export const CATEGORY_NAMES = [
  "dresses", "tops", "denim", "outerwear", "shoes", "bags", "watches", "eyewear", "accessories", "activewear", "kids", "modest",
] as const;
export type CategoryName = (typeof CATEGORY_NAMES)[number];

/** 24-box line icons (stroke 1.75). */
export const CATEGORY_ICONS: Record<CategoryName, readonly string[]> = {
  dresses: ["M9 3L12 6L15 3L16 10L19 21H5L8 10Z", "M8 10H16"],
  tops: ["M8 4L12 6L16 4L21 7L19 11L17 10V20H7V10L5 11L3 7Z"],
  denim: ["M7 3H17L18 21H13L12 10L11 21H6Z", "M12 3V10"],
  outerwear: ["M8 3L12 7L16 3L21 6L20 17H17L16.5 21H7.5L7 17H4L3 6Z", "M12 7V21"],
  shoes: ["M3 15V11L8 10L10 7L13 9C17 9 21 11 21 15V17H3Z", "M3 15H21"],
  bags: ["M5 8H19L20 21H4Z", "M9 8V6A3 3 0 0 1 15 6V8"],
  watches: ["M9 3H15L16 7H8Z", "M8 17H16L15 21H9Z", circle(12, 12, 5), "M12 10V12L14 13"],
  eyewear: ["M4 9H10.5V12.5A3 3 0 0 1 7.5 15.5H7A3 3 0 0 1 4 12.5Z", "M13.5 9H20V12.5A3 3 0 0 1 17 15.5H16.5A3 3 0 0 1 13.5 12.5Z", "M10.5 11H13.5"],
  accessories: ["M6 4H18L22 10L12 21L2 10Z", "M2 10H22", "M9 4L7 10L12 21L17 10L15 4"],
  activewear: ["M5 5H19L20 15H13L12 11L11 15H4Z", "M5 8H19"],
  kids: ["M8 5L12 7L16 5L20 8L18 11L16 10V19H8V10L6 11L4 8Z", "M12 11L12.8 12.8L14.6 13L13.2 14.2L13.6 16L12 15L10.4 16L10.8 14.2L9.4 13L11.2 12.8Z"],
  modest: ["M9 3H15L17 8L21 21H3L7 8Z", "M12 6V21"],
};
