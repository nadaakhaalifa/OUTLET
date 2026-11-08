import raw from "./synonyms.v1.json" with { type: "json" };
import { normalizeArabic } from "./normalize.js";

export type GroupKind = "category" | "color" | "material" | "audience" | "style" | "occasion" | "season" | "brand";

export interface SynonymGroup {
  readonly id: string;
  readonly kind: GroupKind;
  readonly ar: readonly string[];
  readonly en: readonly string[];
  readonly franco: readonly string[];
}

interface RawLexicon {
  readonly version: number;
  readonly stopwords: readonly string[];
  readonly groups: readonly SynonymGroup[];
}

const data = raw as unknown as RawLexicon;

export const SYNONYM_VERSION = data.version;
export const GROUPS: readonly SynonymGroup[] = data.groups;
export const STOPWORDS: ReadonlySet<string> = new Set(data.stopwords.map(normalizeArabic));

export const groupVariants = (g: SynonymGroup): string[] => [...g.ar, ...g.en, ...g.franco].map(normalizeArabic);

const build = (): { map: Map<string, string>; conflicts: string[] } => {
  const map = new Map<string, string>();
  const conflicts: string[] = [];
  for (const g of GROUPS) {
    for (const v of groupVariants(g)) {
      const prev = map.get(v);
      if (prev !== undefined && prev !== g.id) conflicts.push(`${v}: ${prev} vs ${g.id}`);
      else map.set(v, g.id);
    }
  }
  return { map, conflicts };
};

const built = build();
/** normalised variant (any script) -> group id */
export const VARIANT_TO_GROUP: ReadonlyMap<string, string> = built.map;
/** Variants claimed by two different groups (must stay empty; asserted in tests). */
export const LEXICON_CONFLICTS: readonly string[] = built.conflicts;

const byId = new Map(GROUPS.map((g) => [g.id, g] as const));
export const groupById = (id: string): SynonymGroup | undefined => byId.get(id);

/** English canonical term used when a concept is sent to an engine. */
export const canonicalTerm = (id: string): string => normalizeArabic(byId.get(id)?.en[0] ?? id);
