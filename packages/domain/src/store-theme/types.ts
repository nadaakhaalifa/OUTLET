// Store theme document (ADR-0057, spec store-branding-and-preview 2.1). Pure data: closed enums,
// bounded numbers and #RRGGBB strings. No CSS, URLs or font names from sellers.

export const THEME_SCHEMA_VERSION = 1 as const;

/** The 7 hex palette roles a store controls per scheme (heroScrim is separate: hex plus alpha). */
export const PALETTE_ROLES = [
  "background",
  "surface",
  "text",
  "textMuted",
  "accent",
  "onAccent",
  "border",
] as const;
export type PaletteRole = (typeof PALETTE_ROLES)[number];

export interface HeroScrim {
  readonly hex: string;
  /** 0..MAX_SCRIM_ALPHA */
  readonly alpha: number;
}
export const MAX_SCRIM_ALPHA = 0.8;

export type PaletteColours = { readonly [R in PaletteRole]: string };
export interface Palette extends PaletteColours {
  readonly heroScrim: HeroScrim;
}

export const SCHEME_POLICIES = ["follow_system", "light_only", "dark_only"] as const;
export type SchemePolicy = (typeof SCHEME_POLICIES)[number];
export const DISPLAY_SCALES = ["modest", "standard", "editorial"] as const;
export type DisplayScale = (typeof DISPLAY_SCALES)[number];
export const DISPLAY_WEIGHTS = ["regular", "medium", "semibold"] as const;
export type DisplayWeight = (typeof DISPLAY_WEIGHTS)[number];
export const RADII = ["sharp", "soft", "round", "pill"] as const;
export type Radius = (typeof RADII)[number];
export const GRID_DENSITIES = ["airy", "regular", "compact"] as const;
export type GridDensity = (typeof GRID_DENSITIES)[number];
export const MOTION_MOODS = ["still", "calm", "lively"] as const;
export type MotionMood = (typeof MOTION_MOODS)[number];
export const CARD_ASPECTS = ["3:4", "4:5", "1:1"] as const;
export type CardAspect = (typeof CARD_ASPECTS)[number];
export const IMAGE_BACKDROPS = ["none", "surface", "accent_soft"] as const;
export type ImageBackdrop = (typeof IMAGE_BACKDROPS)[number];
export const PRODUCT_GRID_SORTS = ["newest", "trending", "price_asc", "price_desc"] as const;
export type ProductGridSort = (typeof PRODUCT_GRID_SORTS)[number];

export const MAX_SECTIONS = 8;
export const MAX_TAGLINE_LENGTH = 80;
export const MAX_EDITORIAL_LENGTH = 400;
export const MAX_LOOKBOOK_ASSETS = 6;

export interface LocalisedText {
  readonly ar: string;
  readonly en: string;
}

export type ThemeSection =
  | { readonly kind: "hero" }
  | { readonly kind: "featured_collection"; readonly collectionId: string }
  | { readonly kind: "product_grid"; readonly sort: ProductGridSort }
  | { readonly kind: "editorial_text"; readonly text: LocalisedText }
  | { readonly kind: "lookbook"; readonly assetIds: readonly string[] }
  | { readonly kind: "category_shortcuts" };

export interface ThemeDocument {
  readonly schemaVersion: typeof THEME_SCHEMA_VERSION;
  readonly presetKey: string | null;
  readonly light: Palette;
  /** null = derived by the platform (spec 2.4) */
  readonly dark: Palette | null;
  readonly schemePolicy: SchemePolicy;
  /** id from the font pairing allow-list, or "platform_default" */
  readonly pairingId: string;
  readonly displayScale: DisplayScale;
  readonly displayWeight: DisplayWeight;
  readonly radius: Radius;
  readonly grid: GridDensity;
  readonly motion: MotionMood;
  readonly cardAspect: CardAspect;
  readonly imageBackdrop: ImageBackdrop;
  readonly logoAssetId: string | null;
  readonly wordmarkAssetId: string | null;
  readonly coverAssetId: string | null;
  readonly tagline: LocalisedText | null;
  readonly sections: readonly ThemeSection[];
}
