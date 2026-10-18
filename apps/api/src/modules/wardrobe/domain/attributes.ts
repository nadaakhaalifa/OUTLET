import { z } from "zod";
import { SEASONS, SLOTS, ownedSlotsConsistent, type Season, type Slot } from "./bridge";

/** Canonical colour ids shared with the stylist compatibility rules (packages/domain stylist compat). */
export const COLOURS = [
  "black", "white", "grey", "beige", "navy", "denim", "cream", "brown",
  "red", "olive", "pink", "blue", "orange", "green", "yellow", "purple", "teal", "coral", "burgundy", "mustard",
] as const;
export const CATEGORIES = [...SLOTS, "outerwear"] as const;
export const PATTERNS = ["solid", "striped", "floral", "checked", "printed", "other"] as const;
export const MATERIALS = ["cotton", "linen", "wool", "denim", "leather", "silk", "synthetic", "knit", "other"] as const;

export type Category = (typeof CATEGORIES)[number];

/** Closed vocabulary, strict: no free text ever enters an attribute (it can reach a prompt, LLM01/LLM02). */
export const AttributesSchema = z
  .object({
    category: z.enum(CATEGORIES),
    palette: z.array(z.enum(COLOURS)).min(1).max(3),
    pattern: z.enum(PATTERNS),
    formality: z.number().int().min(0).max(4),
    seasons: z.array(z.enum(SEASONS)).min(1).max(5),
    material: z.enum(MATERIALS),
    /** The shopper's own statement that the garment meets modest coverage. Unknown counts as not modest. */
    modest: z.boolean(),
  })
  .strict();
export type Attributes = z.infer<typeof AttributesSchema>;

/** A stored item may be incomplete (photo uploaded, attributes not yet entered). */
export const PartialAttributesSchema = AttributesSchema.partial().strict();
export type PartialAttributes = z.infer<typeof PartialAttributesSchema>;

const uniq = <T>(a: readonly T[]): T[] => [...new Set(a)];

/** Merge a patch over stored attributes and de-duplicate list fields (stable, sorted by vocabulary order). */
export function mergeAttributes(base: PartialAttributes, patch: PartialAttributes): PartialAttributes {
  const out: PartialAttributes = { ...base, ...patch };
  return {
    ...out,
    ...(out.palette === undefined ? {} : { palette: COLOURS.filter((c) => uniq(out.palette ?? []).includes(c)) }),
    ...(out.seasons === undefined ? {} : { seasons: SEASONS.filter((s) => uniq(out.seasons ?? []).includes(s)) }),
  };
}

export const isComplete = (a: PartialAttributes): a is Attributes => AttributesSchema.safeParse(a).success;

/** Category to outfit slot. Outerwear has no slot in the stylist templates, so it is never "owned". */
export const slotOf = (c: Category): Slot | null => (c === "outerwear" ? null : c);

export interface OwnedItem {
  readonly id: string;
  readonly attributes: PartialAttributes;
  readonly createdAtMs: number;
}

export interface OwnedContext {
  readonly formality: number;
  readonly season: Season;
  readonly modest: boolean;
}

export interface OwnedPick {
  readonly slot: Slot;
  readonly itemId: string;
}

const seasonOk = (s: readonly Season[], want: Season): boolean => want === "all" || s.includes("all") || s.includes(want);

/** 0..1000: how well a garment fits the occasion. null when it is not eligible at all. */
export function itemFit(a: Attributes, ctx: OwnedContext): number | null {
  const gap = Math.abs(a.formality - ctx.formality);
  if (gap > 1) return null;
  if (!seasonOk(a.seasons, ctx.season)) return null;
  if (ctx.modest && !a.modest) return null;
  return 1000 - gap * 250;
}

/**
 * Chooses which owned garments fill slots for an occasion. Deterministic: best fit, then oldest, then
 * id. The result always satisfies the calendar's owned-set rule (a dress excludes top and bottom), and
 * `restrictTo`, when given, limits the choice to the shopper's selected items.
 */
export function selectOwned(items: readonly OwnedItem[], ctx: OwnedContext, restrictTo?: ReadonlySet<string>): readonly OwnedPick[] {
  const best = new Map<Slot, { id: string; fit: number; at: number }>();
  for (const it of items) {
    if (restrictTo !== undefined && !restrictTo.has(it.id)) continue;
    const parsed = AttributesSchema.safeParse(it.attributes);
    if (!parsed.success) continue;
    const slot = slotOf(parsed.data.category);
    if (slot === null) continue;
    const fit = itemFit(parsed.data, ctx);
    if (fit === null) continue;
    const cur = best.get(slot);
    const better =
      cur === undefined ||
      fit > cur.fit ||
      (fit === cur.fit && (it.createdAtMs < cur.at || (it.createdAtMs === cur.at && it.id < cur.id)));
    if (better) best.set(slot, { id: it.id, fit, at: it.createdAtMs });
  }
  const dress = best.get("dress");
  const top = best.get("top");
  const bottom = best.get("bottom");
  // One template only: a dress, or a top and a bottom. A lone top or bottom competes with the dress on fit.
  const separates = (top?.fit ?? 0) + (bottom?.fit ?? 0);
  const keepDress = dress !== undefined && (top === undefined || bottom === undefined ? dress.fit >= Math.max(top?.fit ?? 0, bottom?.fit ?? 0) : dress.fit * 2 >= separates);
  if (keepDress) {
    best.delete("top");
    best.delete("bottom");
  } else {
    best.delete("dress");
  }
  const picks: OwnedPick[] = [];
  for (const s of SLOTS) {
    const b = best.get(s);
    if (b !== undefined) picks.push({ slot: s, itemId: b.id });
  }
  return ownedSlotsConsistent(picks.map((p) => p.slot)) ? picks : [];
}
