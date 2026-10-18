export type ColorScheme = "light" | "dark";

/**
 * Semantic colour tokens. Components read roles, never raw hex.
 * Identity: deep teal (`brand`) on warm paper (light) and DEEP teal ink (dark), with sand as the quiet warm fill and hairlines.
 * `brand` marks identity moments only (monogram eyelet, active indicators, focus, one hero accent).
 * Emerald is ONLY for verified savings, coral ONLY for genuine urgency/errors, gold ONLY for Plus.
 * Every value is a string (the web apps turn each key into a CSS custom property).
 */
export interface ColorTokens {
  /** Page. */
  readonly background: string;
  /** Raised surface (sheets, inputs). */
  readonly surface: string;
  /** The single quiet neutral fill (chips, skeletons, image placeholders). */
  readonly fill: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  /** Hairline divider / outline. Decorative, not a text colour. */
  readonly border: string;
  readonly hairline: string;
  /** Visible control outline (inputs, outlined chips): >= 3:1 against background and surface (WCAG 1.4.11). */
  readonly fieldBorder: string;
  /** Primary action colour: ink. */
  readonly accent: string;
  readonly onAccent: string;
  /** Errors and genuine urgency. */
  readonly danger: string;
  readonly onDanger: string;
  /** Verified savings only. */
  readonly savings: string;
  readonly onSavings: string;
  /** Plus / premium accent. */
  readonly plus: string;
  readonly onPlus: string;
  /** Quiet gold surface, its text and its border (Plus badge and the warning tone). Contrast unit-tested in ui-native. */
  readonly plusSurface: string;
  readonly onPlusSurface: string;
  readonly plusBorder: string;
  /** Text and icons placed over imagery behind a scrim. */
  readonly onImage: string;
  /** Scrim base colour (black) used with alpha over imagery. */
  readonly scrim: string;
  /** Frosted glass: tint fill, border, highlight, solid fallback (reduce transparency). */
  readonly glassTint: string;
  readonly glassBorder: string;
  readonly glassHighlight: string;
  readonly glassSolid: string;
  /** Signature deep teal. Identity moments only: active indicators, focus, wordmark hyphen, one accent per screen. */
  readonly brand: string;
  readonly onBrand: string;
  /** Quiet tint of the brand for selected backgrounds. */
  readonly brandSoft: string;
  /** Sand / camel: circular category icon buttons and quiet warm fills. `onSand` is the glyph colour on it. */
  readonly sand: string;
  readonly onSand: string;
  /** Fill of the home "View stores" tile, and the off-white nude it turns to while pressed. */
  readonly storesTile: string;
  readonly storesTilePressed: string;
  /** Sage and forest greens: illustration, art and secondary fills (decorative, never meaning). */
  readonly sage: string;
  readonly forest: string;
  /** Glass depth: soft inner shadow along the lower edge and the diagonal sheen. */
  readonly glassShade: string;
  readonly glassSheen: string;
  /** Transparent end stop of the sheen gradient (same hue as `glassSheen`, alpha 0). */
  readonly glassSheenFade: string;
  /** Near-neutral page black behind the dark Profile screen (board 8); equals background in light. */
  readonly ink: string;
  /** Dark tint for glass chips and buttons that sit over imagery. */
  readonly glassTintOnImage: string;
  /** Modal backdrop. */
  readonly overlay: string;
}

/** Fixed brand constants (art kit, icons, splash). Not theme-dependent. */
export const brand = {
  ink: "#0B2527",
  /** Deep teal-black: dark-mode surfaces, splash backdrop. */
  deep: "#071A1C",
  ivory: "#F4EFE6",
  teal: "#12403F",
  forest: "#2F5646",
  sage: "#7FA58F",
  sand: "#D9BFA0",
} as const;

export const colors: Readonly<Record<ColorScheme, ColorTokens>> = {
  light: {
    background: "#EBE4D4",
    surface: "#F1EBDD",
    fill: "#D8CBB1",
    textPrimary: "#0B2527",
    textSecondary: "#3F4F49",
    border: "#C4B692",
    hairline: "#CDBFA2",
    fieldBorder: "#6A6856",
    accent: "#0B2527",
    onAccent: "#F4EFE6",
    danger: "#9A2D14",
    onDanger: "#FFFFFF",
    savings: "#0B5A2F",
    onSavings: "#FFFFFF",
    plus: "#664A14",
    onPlus: "#FFFFFF",
    plusSurface: "#FFF4D6",
    onPlusSurface: "#4A3500",
    plusBorder: "#E0B84A",
    onImage: "#FFFFFF",
    scrim: "#000000",
    glassTint: "rgba(235,228,212,0.72)",
    glassBorder: "rgba(11,37,39,0.08)",
    glassHighlight: "rgba(255,255,255,0.85)",
    glassSolid: "#EBE4D4",
    brand: "#12403F",
    onBrand: "#F4EFE6",
    brandSoft: "rgba(18,64,63,0.08)",
    sand: "#D9BFA0",
    onSand: "#3A2312",
    storesTile: "#B8A48C",
    storesTilePressed: "#F5EEE3",
    sage: "#7FA58F",
    forest: "#2F5646",
    glassShade: "rgba(11,37,39,0.06)",
    glassSheen: "rgba(255,255,255,0.55)",
    glassSheenFade: "rgba(255,255,255,0)",
    ink: "#F4EFE6",
    glassTintOnImage: "rgba(7,26,28,0.5)",
    overlay: "rgba(7,26,28,0.42)",
  },
  dark: {
    background: "#071A1C",
    surface: "#0D2427",
    fill: "#14312F",
    textPrimary: "#F4EFE6",
    textSecondary: "#A9B8B2",
    border: "#3B5C57",
    hairline: "#2A4744",
    fieldBorder: "#5F8580",
    accent: "#F4EFE6",
    onAccent: "#071A1C",
    danger: "#F27A57",
    onDanger: "#071A1C",
    savings: "#5BCB7A",
    onSavings: "#071A1C",
    plus: "#D4B26A",
    onPlus: "#071A1C",
    plusSurface: "#3A2D05",
    onPlusSurface: "#FFE9A8",
    plusBorder: "#8A6D12",
    onImage: "#FFFFFF",
    scrim: "#000000",
    glassTint: "rgba(7,26,28,0.72)",
    glassBorder: "rgba(255,255,255,0.10)",
    glassHighlight: "rgba(255,255,255,0.16)",
    glassSolid: "#0B2023",
    brand: "#8CC5C0",
    onBrand: "#071A1C",
    brandSoft: "rgba(140,197,192,0.14)",
    sand: "#C9AE8A",
    onSand: "#071A1C",
    storesTile: "#D9BFA0",
    storesTilePressed: "#F5EEE3",
    sage: "#8DB39C",
    forest: "#2F5646",
    glassShade: "rgba(0,0,0,0.16)",
    glassSheen: "rgba(255,255,255,0.05)",
    glassSheenFade: "rgba(255,255,255,0)",
    ink: "#0E0F0F",
    glassTintOnImage: "rgba(7,26,28,0.5)",
    overlay: "rgba(0,0,0,0.62)",
  },
};

/** 4pt grid. Legacy keys (xs..xxl) kept; numeric steps added. Shared with the web apps (CSS variables). */
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48, huge: 64 } as const;
/** Native page gutter (density v2: 20 -> 16, matching the reference layout). Not used by the web apps. */
export const gutter = 16;
/**
 * Radius scale (v2): `md` 14 = buttons and inputs, `lg` 18 = cards and images, `xl` 24 = sheets, `pill` = chips, tab pills,
 * circular icon buttons (use `pill` with a square box).
 */
export const radius = { xs: 4, sm: 8, md: 14, tile: 16, lg: 18, xl: 24, xxl: 32, pill: 999 } as const;

export type FontWeight = "300" | "400" | "500" | "600";
/** `display` = editorial serif (Playfair Display / Amiri); `text` = Inter (IBM Plex Sans Arabic for Arabic). */
export type FontFace = "display" | "text";
export interface TypeStyle {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight: FontWeight;
  /** Letter spacing in points (Latin only; Arabic always 0). */
  readonly letterSpacing: number;
  readonly uppercase: boolean;
  readonly face: FontFace;
}

/**
 * WEB type scale (seller-web, admin-web, shopper-web turn it into CSS). Kept at 16px body on purpose: browsers zoom
 * focused inputs under 16px (iOS Safari) and desktop reading distance suits it. The native app reads
 * `nativeTypography` (density v2) instead; see docs/design-system/density-v2.md.
 * Editorial scale: large confident serif display, quiet sans text, tracked small-caps eyebrows.
 * Legacy keys `title`, `heading`, `body`, `caption` kept. Arabic gets +10% line height and no tracking.
 */
export const typography = {
  hero: { fontSize: 48, lineHeight: 54, fontWeight: "400", letterSpacing: -0.6, uppercase: false, face: "display" },
  display: { fontSize: 38, lineHeight: 46, fontWeight: "400", letterSpacing: -0.4, uppercase: false, face: "display" },
  title1: { fontSize: 28, lineHeight: 34, fontWeight: "400", letterSpacing: -0.3, uppercase: false, face: "display" },
  quote: { fontSize: 22, lineHeight: 30, fontWeight: "400", letterSpacing: -0.1, uppercase: false, face: "display" },
  title2: { fontSize: 20, lineHeight: 26, fontWeight: "400", letterSpacing: 0, uppercase: false, face: "text" },
  headline: { fontSize: 17, lineHeight: 24, fontWeight: "500", letterSpacing: 0, uppercase: false, face: "text" },
  lede: { fontSize: 17, lineHeight: 26, fontWeight: "400", letterSpacing: 0, uppercase: false, face: "text" },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400", letterSpacing: 0, uppercase: false, face: "text" },
  callout: { fontSize: 15, lineHeight: 22, fontWeight: "400", letterSpacing: 0, uppercase: false, face: "text" },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: "400", letterSpacing: 0, uppercase: false, face: "text" },
  /** Store and brand names (caption + 1 step, semibold, never uppercase: it harms Arabic). Colour is textPrimary, set by the kit StoreName. */
  brandName: { fontSize: 14, lineHeight: 20, fontWeight: "600", letterSpacing: 0, uppercase: false, face: "text" },
  eyebrow: { fontSize: 11, lineHeight: 14, fontWeight: "500", letterSpacing: 2.2, uppercase: true, face: "text" },
  /** Compact secondary line (card hints). Additive; below the 12pt body floor on purpose. */
  micro: { fontSize: 10.5, lineHeight: 14, fontWeight: "400", letterSpacing: 0, uppercase: false, face: "text" },
  /** Offer card headline (Latin lining figures, Inter semibold). Additive. */
  offer: { fontSize: 24, lineHeight: 30, fontWeight: "600", letterSpacing: -0.3, uppercase: false, face: "text" },
  /** Label on image tiles (department tiles). Additive; tracked semibold UI sans. */
  tile: { fontSize: 13, lineHeight: 17, fontWeight: "600", letterSpacing: 0.3, uppercase: false, face: "text" },
  /** Legacy aliases. */
  title: { fontSize: 28, lineHeight: 34, fontWeight: "400", letterSpacing: -0.3, uppercase: false, face: "display" },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: "400", letterSpacing: 0, uppercase: false, face: "text" },
} as const satisfies Record<string, TypeStyle>;

export type TypeVariant = keyof typeof typography;

/**
 * NATIVE type scale, density v2 ("zoom out"): about 12-17% smaller on the display end, 1pt smaller on body and
 * callout, same keys as `typography`. Everything the Expo app renders through the kit `Text` reads this table.
 * Arabic metrics are derived at render time (+10% line height rounded to even, no tracking) in ui-native `textMetrics`.
 * Dynamic Type still scales every value (kit cap `MAX_FONT_SCALE`).
 */
export const nativeTypography = {
  hero: { fontSize: 40, lineHeight: 46, fontWeight: "400", letterSpacing: -0.5, uppercase: false, face: "display" },
  display: { fontSize: 32, lineHeight: 38, fontWeight: "400", letterSpacing: -0.3, uppercase: false, face: "display" },
  title1: { fontSize: 24, lineHeight: 30, fontWeight: "400", letterSpacing: -0.2, uppercase: false, face: "display" },
  quote: { fontSize: 19, lineHeight: 26, fontWeight: "400", letterSpacing: -0.1, uppercase: false, face: "display" },
  title2: { fontSize: 18, lineHeight: 24, fontWeight: "400", letterSpacing: 0, uppercase: false, face: "text" },
  headline: { fontSize: 16, lineHeight: 22, fontWeight: "500", letterSpacing: 0, uppercase: false, face: "text" },
  lede: { fontSize: 16, lineHeight: 24, fontWeight: "400", letterSpacing: 0, uppercase: false, face: "text" },
  body: { fontSize: 15, lineHeight: 22, fontWeight: "400", letterSpacing: 0, uppercase: false, face: "text" },
  callout: { fontSize: 14, lineHeight: 20, fontWeight: "400", letterSpacing: 0, uppercase: false, face: "text" },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "400", letterSpacing: 0, uppercase: false, face: "text" },
  /** Store and brand names: 13/18 (Arabic derives 20 line height), semibold, no uppercase. Colour textPrimary via kit StoreName. */
  brandName: { fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0, uppercase: false, face: "text" },
  eyebrow: { fontSize: 10.5, lineHeight: 14, fontWeight: "500", letterSpacing: 2, uppercase: true, face: "text" },
  micro: { fontSize: 10.5, lineHeight: 14, fontWeight: "400", letterSpacing: 0, uppercase: false, face: "text" },
  /** Offer card headline (Latin lining figures, Inter semibold). Additive. */
  offer: { fontSize: 22, lineHeight: 29, fontWeight: "600", letterSpacing: -0.3, uppercase: false, face: "text" },
  /** Label on image tiles (department tiles). Additive; tracked semibold UI sans. */
  tile: { fontSize: 13, lineHeight: 17, fontWeight: "600", letterSpacing: 0.3, uppercase: false, face: "text" },
  /** Legacy aliases. */
  title: { fontSize: 24, lineHeight: 30, fontWeight: "400", letterSpacing: -0.2, uppercase: false, face: "display" },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: "400", letterSpacing: 0, uppercase: false, face: "text" },
} as const satisfies Record<TypeVariant, TypeStyle>;

/** Minimum touch target in points (Apple HIG, WCAG 2.2 target size). */
export const minTouchTarget = 44;

/**
 * Native control sizes (density v2), in points. A visual size under `minTouchTarget` is legal ONLY when the kit adds
 * `hitSlop` so the touch target is still >= 44 (unit-tested: visual + 2 * slop >= 44).
 */
export const controlSize = {
  /** Button height, both densities (compact is 40 visual + 2pt slop). */
  button: 44,
  buttonCompact: 40,
  /** Text field control height. */
  field: 46,
  fieldCompact: 44,
  /** Chip visual heights; hit area raised to 44 with hitSlop. */
  chip: 34,
  chipCompact: 30,
  chipLarge: 40,
  /** Size selector square. */
  sizeCell: 40,
  /** Search pill. */
  search: 44,
  /** Disc drawn inside a 44pt icon button. */
  iconDisc: 36,
  /** Sand category shortcut disc. */
  categoryDisc: 48,
  /** App bar row below the status bar. */
  appBar: 48,
  /** List row minimum. */
  listRow: 48,
} as const;

/** hitSlop (each side) the kit gives a control of a visual height to reach the 44pt minimum. */
export function slopFor(visual: number): number {
  return Math.max(0, Math.ceil((minTouchTarget - visual) / 2));
}

/**
 * iPad adaptation (docs/specs/ipad-adaptation.md, ADR-0054). Everything below is additive: compact (every iPhone) keeps
 * the tables above untouched. The kit multiplies the physical values by `zoom` on regular and expanded windows.
 */
/**
 * THE iPad zoom: one named constant so it can be tuned again. Owner decision 2026-10-16 (1.25, 1.75, 1.25, 1.5, now 1.725 = 1.5 x 1.15): a true zoom from 600 pt windows up, done in the tokens (never a root transform). Every derived size follows it.
 */
export const IPAD_ZOOM = 1.725;
export const zoom = IPAD_ZOOM;
/** Controls and icon glyphs zoom less than text: 62% of the text zoom. */
export const CONTROL_ZOOM_SHARE = 0.62;
/** Control heights and icon glyphs: 1 + (IPAD_ZOOM - 1) * 0.62 (= 1.45 at 1.725). Derived, never a second zoom literal. */
export const CONTROL_ZOOM = 1 + (IPAD_ZOOM - 1) * CONTROL_ZOOM_SHARE;
/**
 * The zoom in force is `z(window width)`, at most IPAD_ZOOM (logic/size-class.ts `zoomForWidth`): 1 below the regular
 * breakpoint, then a continuous ramp 1 + (w - 600) / iphoneEffectiveWidth that never lays a window out narrower than an
 * iPhone (effective width >= iphoneEffectiveWidth) and reaches IPAD_ZOOM at about 872 pt.
 */
export const iphoneEffectiveWidth = 375;
/**
 * Text: Dynamic Type is NOT faded. The text zoom is the zoom in force, so rendered text scale is z * min(fs, 2): Dynamic Type
 * grows iPad text by the same 2x as on the phone, relative to the iPad's default rendering (cap = 2 * z, 3.45 at full zoom).
 */

/** Window-width breakpoint (physical pt): compact below, zoomed at and above. */
export const sizeClassBreakpoints = { regular: 600 } as const;
/** `expanded` (two-pane allowed) starts at this EFFECTIVE window width (window / IPAD_ZOOM). */
export const expandedMinEffectiveWidth = 760;
/** Layout metrics in EFFECTIVE points (window / zoom). The kit renders `round(value * zoom)`. */
export const layoutMetrics = {
  compact: { gutter: 16, sectionGap: 14, gridGap: 12 },
  regular: { gutter: 16, sectionGap: 14, gridGap: 12 },
  expanded: { gutter: 20, sectionGap: 16, gridGap: 12 },
} as const;
/** Two-pane starts at this EFFECTIVE window width (window / zoom): the `expanded` class. */
export const twoPaneMinContentWidth = expandedMinEffectiveWidth;
/** Max widths of the centred content column in EFFECTIVE points (physical = round(value * zoom)). `grid` and `full` have no max (the window caps them). */
export const contentMaxWidth = { form: 440, reading: 560 } as const;
/** Centred form sheet on regular and expanded windows. `width` is effective (physical = round(width * zoom)); below `minEffectiveWindow` effective points the bottom sheet is used. */
export const formSheet = { width: 420, heightRatio: 0.85, minEffectiveWindow: 460 } as const;
/** Toast and tab bar max widths, effective points. */
export const toastMaxWidth = 360;
export const tabBarMaxWidth = 480;
/** Adaptive grid, effective points, per phone density preference 1..4: minimum card width and column cap. */
export const adaptiveGrid = {
  minCard: { 1: 240, 2: 140, 3: 92, 4: 68 },
  cap: { 1: 3, 2: 5, 3: 6, 4: 8 },
} as const;

/**
 * Motion: slow, eased, no bounce. Only transform and opacity animate.
 * Durations in ms; easings are cubic-bezier control points (web can reuse them); springs are critically damped or over-damped.
 */
export const motion = {
  instant: 120,
  fast: 200,
  base: 320,
  slow: 480,
  hero: 720,
  easing: {
    /** Default for entrances and movement: quick start, long soft landing. */
    standard: [0.22, 1, 0.36, 1],
    /** Exits accelerate away. */
    exit: [0.7, 0, 0.84, 0],
    /** Symmetric, for loops and shimmer. */
    inOut: [0.65, 0, 0.35, 1],
  },
  /** Springs never overshoot visibly (damping ratio >= 1). */
  springs: {
    settle: { damping: 32, stiffness: 190, mass: 1 },
    glide: { damping: 38, stiffness: 120, mass: 1 },
    press: { damping: 40, stiffness: 520, mass: 0.7 },
  },
  /** Legacy single spring (kept for existing callers). */
  spring: { damping: 28, stiffness: 220, mass: 1 },
  /** Staggered entrance: per-item delay, max staggered items, travel distance, duration. */
  stagger: { step: 60, max: 8, distance: 16, duration: 520 },
  pressScale: 0.97,
  /** Hero image entrance: starts slightly zoomed and settles. */
  heroScaleFrom: 1.08,
} as const;

/** Glass (BlurView) parameters. */
export const glass = {
  intensity: { bar: 70, sheet: 85, chip: 50 },
  radius: radius.xl,
} as const;

/** Font family names registered by useAppFonts. Inter has no 300 cut bundled: `300` falls back to 400. */
export const fontFamilies = {
  latin: { "300": "Inter_400Regular", "400": "Inter_400Regular", "500": "Inter_500Medium", "600": "Inter_600SemiBold" },
  arabic: { "300": "IBMPlexSansArabic_300Light", "400": "IBMPlexSansArabic_400Regular", "500": "IBMPlexSansArabic_500Medium", "600": "IBMPlexSansArabic_600SemiBold" },
  /** Editorial display faces: Playfair Display (Latin) and Amiri (Arabic Naskh with real stroke contrast). */
  displayLatin: { "300": "PlayfairDisplay_400Regular", "400": "PlayfairDisplay_400Regular", "500": "PlayfairDisplay_500Medium", "600": "PlayfairDisplay_600SemiBold" },
  displayLatinItalic: "PlayfairDisplay_400Regular_Italic",
  displayArabic: { "300": "Amiri_400Regular", "400": "Amiri_400Regular", "500": "Amiri_700Bold", "600": "Amiri_700Bold" },
} as const;

/** Soft, light shadows (teal-tinted ink). Cards float barely; floating is for sheets and the tab bar lift. */
export const shadows = {
  floating: { shadowColor: "#0B2527", shadowOpacity: 0.14, shadowRadius: 28, shadowOffset: { width: 0, height: 12 }, elevation: 10 },
  /** Soft contact shadow for raised cards. */
  lift: { shadowColor: "#0B2527", shadowOpacity: 0.08, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 3 },
  /** Hairline-weight lift for list cards and product tiles. */
  card: { shadowColor: "#0B2527", shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
} as const;
