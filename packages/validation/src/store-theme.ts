import { z } from "zod";
import { storeTheme } from "@outlet/domain";

// Zod boundary schema for the store theme document (ADR-0057, spec 2.1). Closed enums, bounded
// numbers, #RRGGBB only. Contrast and copy rules are enforced by storeTheme.validateThemeForPublish.

const Hex = z.string().regex(storeTheme.HEX_RE);
const Uuid = z.uuid();

const PaletteSchema = z
  .object({
    background: Hex,
    surface: Hex,
    text: Hex,
    textMuted: Hex,
    accent: Hex,
    onAccent: Hex,
    border: Hex,
    heroScrim: z
      .object({ hex: Hex, alpha: z.number().min(0).max(storeTheme.MAX_SCRIM_ALPHA) })
      .strict(),
  })
  .strict();

// Plain text: no control chars (incl. bidi overrides), no URLs.
const hasForbiddenChar = (v: string): boolean =>
  Array.from(v).some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return (
      c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff
    );
  });
const URL_RE = /(?:https?:|www\.|\w+\.(?:com|net|org|io|eg|me|app)\b|:\/\/)/i;
const plain = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((v) => !hasForbiddenChar(v) && !URL_RE.test(v), "plain_text_only");

const LocalisedTextSchema = (max: number) =>
  z.object({ ar: plain(max), en: plain(max) }).strict();

const SectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hero") }).strict(),
  z.object({ kind: z.literal("featured_collection"), collectionId: Uuid }).strict(),
  z.object({ kind: z.literal("product_grid"), sort: z.enum(storeTheme.PRODUCT_GRID_SORTS) }).strict(),
  z.object({ kind: z.literal("editorial_text"), text: LocalisedTextSchema(storeTheme.MAX_EDITORIAL_LENGTH) }).strict(),
  z
    .object({
      kind: z.literal("lookbook"),
      assetIds: z.array(Uuid).min(1).max(storeTheme.MAX_LOOKBOOK_ASSETS),
    })
    .strict(),
  z.object({ kind: z.literal("category_shortcuts") }).strict(),
]);

export const ThemeDocumentSchema = z
  .object({
    schemaVersion: z.literal(storeTheme.THEME_SCHEMA_VERSION),
    presetKey: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).nullable(),
    light: PaletteSchema,
    dark: PaletteSchema.nullable(),
    schemePolicy: z.enum(storeTheme.SCHEME_POLICIES),
    pairingId: z.string().refine((v) => storeTheme.FONT_PAIRING_IDS.includes(v), "unknown_pairing"),
    displayScale: z.enum(storeTheme.DISPLAY_SCALES),
    displayWeight: z.enum(storeTheme.DISPLAY_WEIGHTS),
    radius: z.enum(storeTheme.RADII),
    grid: z.enum(storeTheme.GRID_DENSITIES),
    motion: z.enum(storeTheme.MOTION_MOODS),
    cardAspect: z.enum(storeTheme.CARD_ASPECTS),
    imageBackdrop: z.enum(storeTheme.IMAGE_BACKDROPS),
    logoAssetId: Uuid.nullable(),
    wordmarkAssetId: Uuid.nullable(),
    coverAssetId: Uuid.nullable(),
    tagline: LocalisedTextSchema(storeTheme.MAX_TAGLINE_LENGTH).nullable(),
    sections: z.array(SectionSchema).max(storeTheme.MAX_SECTIONS),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (!storeTheme.pairingSupportsWeight(t.pairingId, t.displayWeight)) {
      ctx.addIssue({ code: "custom", path: ["displayWeight"], message: "weight_unavailable" });
    }
    if (t.tagline !== null && t.tagline.ar.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["tagline", "ar"], message: "tagline_arabic_required" });
    }
  });

export type ThemeDocumentInput = z.input<typeof ThemeDocumentSchema>;

/** Parses untrusted JSON into the domain type; contrast and copy rules are a separate publish step. */
export function parseThemeDocument(
  raw: unknown,
): { ok: true; theme: storeTheme.ThemeDocument } | { ok: false; error: z.ZodError } {
  const r = ThemeDocumentSchema.safeParse(raw);
  return r.success ? { ok: true, theme: r.data as storeTheme.ThemeDocument } : { ok: false, error: r.error };
}
