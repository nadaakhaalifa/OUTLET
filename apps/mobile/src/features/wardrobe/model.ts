/**
 * Wardrobe digitization (spec: docs/specs/phase-3/wardrobe.md, ADR-0043). Photos go through a signed upload; attributes
 * are a closed vocabulary; a vision suggestion is `needsReview` until the shopper confirms it. Money is piastres (bigint).
 */
import { AiFailure, type AiFailureReason } from "../ai-failure";
import { FIXTURE_OUTFITS, type MissingSlot, type Outfit, type Slot } from "../stylist/model";

export const CATEGORIES = ["top", "bottom", "dress", "shoes", "bag", "accessory", "outerwear"] as const;
export type Category = (typeof CATEGORIES)[number];
export const COLOURS = ["black", "white", "grey", "beige", "navy", "denim", "cream", "brown", "red", "olive", "pink", "blue", "orange", "green", "yellow", "purple", "teal", "coral", "burgundy", "mustard"] as const;
export type Colour = (typeof COLOURS)[number];
export const PATTERNS = ["solid", "striped", "floral", "checked", "printed", "other"] as const;
export type Pattern = (typeof PATTERNS)[number];
export const MATERIALS = ["cotton", "linen", "wool", "denim", "leather", "silk", "synthetic", "knit", "other"] as const;
export type Material = (typeof MATERIALS)[number];
export const WARDROBE_SEASONS = ["summer", "winter", "spring", "autumn", "all"] as const;
export type WardrobeSeason = (typeof WARDROBE_SEASONS)[number];
export const FORMALITY = [0, 1, 2, 3, 4] as const;
export type Formality = (typeof FORMALITY)[number];

/** Server caps. */
export const WARDROBE_CAP = 300;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_PALETTE = 3;
export const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PhotoType = (typeof ALLOWED_PHOTO_TYPES)[number];

export interface WardrobeAttributes {
  readonly category: Category | null;
  readonly palette: readonly Colour[];
  readonly pattern: Pattern | null;
  readonly formality: Formality | null;
  readonly seasons: readonly WardrobeSeason[];
  readonly material: Material | null;
  readonly modest: boolean | null;
}

export const EMPTY_ATTRIBUTES: WardrobeAttributes = { category: null, palette: [], pattern: null, formality: null, seasons: [], material: null, modest: null };

export type PhotoState = "none" | "pending_scan" | "clean" | "rejected";

export interface WardrobeItem {
  readonly id: string;
  readonly attributes: WardrobeAttributes;
  readonly source: "user" | "vision";
  /** A vision suggestion the shopper has not confirmed. */
  readonly needsReview: boolean;
  readonly complete: boolean;
  readonly photo: PhotoState;
  readonly version: number;
}

export interface WardrobeLookRequest {
  readonly kind: "work" | "wedding_guest" | "date" | "eid" | "university" | "travel" | "custom";
  readonly modest: boolean;
  /** Piastres, or null for no limit. */
  readonly budget: bigint | null;
}

export interface WardrobeLook {
  readonly outfits: readonly Outfit[];
  /** Slots filled from the wardrobe at no cost, per outfit id. */
  readonly ownedSlots: Readonly<Record<string, readonly Slot[]>>;
  readonly ownedOnly: boolean;
  readonly shortfall: readonly MissingSlot[];
  readonly source: "ai" | "rules";
  readonly remainingToday: number | null;
}

export interface WardrobePort {
  list(): Promise<readonly WardrobeItem[]>;
  /** Uploads the photo (when given) through the signed-upload flow, then creates the item. */
  add(input: { readonly photoUri: string | null; readonly attributes: WardrobeAttributes }): Promise<WardrobeItem>;
  suggest(id: string): Promise<WardrobeItem>;
  update(id: string, attributes: WardrobeAttributes, expectedVersion: number): Promise<WardrobeItem>;
  remove(id: string): Promise<void>;
  /** Deletes every item and photo. */
  clear(): Promise<void>;
  /** A short-lived signed URL for a clean photo, or null. */
  photoUrl(id: string): Promise<string | null>;
  completeLook(req: WardrobeLookRequest): Promise<WardrobeLook>;
}

/* ---- pure logic ---- */

const OCCASION_KIND: Readonly<Record<string, WardrobeLookRequest["kind"]>> = {
  work: "work", weddingGuest: "wedding_guest", date: "date", eid: "eid", university: "university",
};
/** Stylist occasions without a wardrobe equivalent (beach, gym) use "custom". */
export function wardrobeKindFor(occasion: string): WardrobeLookRequest["kind"] {
  return OCCASION_KIND[occasion] ?? "custom";
}

/** Fields still empty (drives the "complete this piece" hint). */
export function missingFields(a: WardrobeAttributes): readonly ("category" | "palette" | "pattern" | "formality" | "seasons" | "material")[] {
  const out: ("category" | "palette" | "pattern" | "formality" | "seasons" | "material")[] = [];
  if (a.category === null) out.push("category");
  if (a.palette.length === 0) out.push("palette");
  if (a.pattern === null) out.push("pattern");
  if (a.formality === null) out.push("formality");
  if (a.seasons.length === 0) out.push("seasons");
  if (a.material === null) out.push("material");
  return out;
}

/** Toggles a colour, keeping at most MAX_PALETTE (the oldest pick drops out). */
export function togglePalette(current: readonly Colour[], c: Colour): readonly Colour[] {
  if (current.includes(c)) return current.filter((x) => x !== c);
  return [...current, c].slice(-MAX_PALETTE);
}

/** "all" is exclusive: picking it clears the rest, picking a season clears "all". */
export function toggleSeason(current: readonly WardrobeSeason[], s: WardrobeSeason): readonly WardrobeSeason[] {
  if (s === "all") return current.includes("all") ? [] : ["all"];
  const without = current.filter((x) => x !== "all");
  return without.includes(s) ? without.filter((x) => x !== s) : [...without, s];
}

export function atCapacity(count: number): boolean {
  return count >= WARDROBE_CAP;
}

/** Picks the upload content type: the blob type when allowed, else from the file extension, else JPEG. */
export function photoTypeOf(blobType: string, uri: string): PhotoType {
  const lower = blobType.toLowerCase();
  const direct = ALLOWED_PHOTO_TYPES.find((t) => t === lower);
  if (direct !== undefined) return direct;
  const ext = /\.([a-z0-9]+)(?:\?.*)?$/i.exec(uri)?.[1]?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

/** Signed upload URLs must be https (plain http only for local development hosts). */
export function isSafeUploadUrl(url: string): boolean {
  return /^https:\/\/[^\s/]+/i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?\//i.test(url);
}

export function canSuggest(item: WardrobeItem): boolean {
  return item.photo === "clean" && !(item.source === "user" && item.complete);
}

/** Items whose attributes the shopper still has to confirm (shown first and counted). */
export function reviewCount(items: readonly WardrobeItem[]): number {
  return items.filter((i) => i.needsReview).length;
}

export function sortItems(items: readonly WardrobeItem[]): readonly WardrobeItem[] {
  return [...items].sort((a, b) => Number(b.needsReview) - Number(a.needsReview));
}

/** Maps a completion result to the stylist's result shape. Owned-only looks have no purchasable items. */
export function lookToResult(look: WardrobeLook): { readonly outfits: readonly Outfit[]; readonly source: "ai" | "rules" } {
  return { outfits: look.outfits, source: look.source };
}

/* ---- in-memory fake (development and tests only; synthetic data) ---- */

export class InMemoryWardrobePort implements WardrobePort {
  private items: WardrobeItem[] = [];
  private n = 0;
  constructor(private failure: AiFailureReason | null = null, private readonly cap = WARDROBE_CAP) {}
  setFailure(f: AiFailureReason | null): void {
    this.failure = f;
  }
  private check(): void {
    if (this.failure !== null) throw new AiFailure(this.failure);
  }
  async list(): Promise<readonly WardrobeItem[]> {
    this.check();
    return this.items;
  }
  async add(input: { photoUri: string | null; attributes: WardrobeAttributes }): Promise<WardrobeItem> {
    this.check();
    if (this.items.length >= this.cap) throw new AiFailure("full");
    this.n += 1;
    const item: WardrobeItem = {
      id: `w-${this.n}`,
      attributes: input.attributes,
      source: "user",
      needsReview: false,
      complete: missingFields(input.attributes).length === 0,
      photo: input.photoUri === null ? "none" : "clean",
      version: 1,
    };
    this.items.push(item);
    return item;
  }
  async suggest(id: string): Promise<WardrobeItem> {
    this.check();
    const cur = this.items.find((i) => i.id === id);
    if (cur === undefined) throw new AiFailure("notFound");
    if (cur.photo !== "clean") throw new AiFailure("rejected");
    const next: WardrobeItem = {
      ...cur,
      attributes: { category: "top", palette: ["navy"], pattern: "solid", formality: 2, seasons: ["all"], material: "cotton", modest: true },
      source: "vision",
      needsReview: true,
      complete: true,
      version: cur.version + 1,
    };
    this.items = this.items.map((i) => (i.id === id ? next : i));
    return next;
  }
  async update(id: string, attributes: WardrobeAttributes, expectedVersion: number): Promise<WardrobeItem> {
    this.check();
    const cur = this.items.find((i) => i.id === id);
    if (cur === undefined) throw new AiFailure("notFound");
    if (cur.version !== expectedVersion) throw new AiFailure("conflict");
    const next: WardrobeItem = { ...cur, attributes, source: "user", needsReview: false, complete: missingFields(attributes).length === 0, version: cur.version + 1 };
    this.items = this.items.map((i) => (i.id === id ? next : i));
    return next;
  }
  async remove(id: string): Promise<void> {
    this.check();
    if (!this.items.some((i) => i.id === id)) throw new AiFailure("notFound");
    this.items = this.items.filter((i) => i.id !== id);
  }
  async clear(): Promise<void> {
    this.check();
    this.items = [];
  }
  async photoUrl(): Promise<string | null> {
    this.check();
    return null;
  }
  async completeLook(): Promise<WardrobeLook> {
    this.check();
    const owned = this.items.filter((i) => i.attributes.category !== null && i.attributes.category !== "outerwear");
    if (owned.length === 0) throw new AiFailure("nothingOwned");
    const slots: Slot[] = [];
    for (const i of owned) {
      const c = i.attributes.category;
      if (c !== null && c !== "outerwear" && !slots.includes(c)) slots.push(c);
    }
    const outfit = FIXTURE_OUTFITS[0];
    return {
      outfits: outfit === undefined ? [] : [{ ...outfit, items: outfit.items.filter((i) => !slots.includes(i.slot)) }],
      ownedSlots: outfit === undefined ? {} : { [outfit.id]: slots },
      ownedOnly: false,
      shortfall: [],
      source: "ai",
      remainingToday: 29,
    };
  }
}
