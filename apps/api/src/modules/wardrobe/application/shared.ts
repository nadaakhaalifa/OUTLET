import type {
  BudgetPort,
  CandidateSourcePort,
  EmbeddingPort,
  PersonalizationPort,
  StylistFlagPort,
  StylistStore,
} from "../../stylist";
import type { Attributes } from "../domain/attributes";
import type { Clock, IdPort, VisionAttributePort, WardrobeConsentPort, WardrobeFlagPort, WardrobeImageStorePort, WardrobeItem, WardrobeStore } from "../domain/ports";

/** Kill switches (packages/feature-flags registry). `true` means the capability is allowed. */
export const FLAG_WARDROBE = "kill.wardrobe";
export const FLAG_WARDROBE_VISION = "kill.wardrobe_vision";
export const FLAG_STYLIST_ML = "kill.stylist_ml";

export interface WardrobeConfig {
  /** Items per shopper. */
  readonly maxItems: number;
  /** Unconsumed signed uploads per shopper at once. */
  readonly maxPendingUploads: number;
  readonly maxImageBytes: number;
  readonly signedGetTtlSeconds: number;
  /** Same fair-use ceiling as the stylist (spec 11): wardrobe completions count against it. */
  readonly dailyGenerations: number;
  readonly mlTimeoutMs: number;
  readonly freeDeliveryThresholdPiastres: bigint;
}

export const DEFAULT_WARDROBE_CONFIG: WardrobeConfig = {
  maxItems: 300,
  maxPendingUploads: 20,
  maxImageBytes: 10 * 1024 * 1024,
  signedGetTtlSeconds: 300,
  dailyGenerations: 30,
  mlTimeoutMs: 800,
  freeDeliveryThresholdPiastres: 200_000n,
};

/** The stylist module's ports and persistence, resolved from the same instances the stylist uses. */
export interface StylistPorts {
  readonly candidates: CandidateSourcePort;
  readonly embeddings: EmbeddingPort;
  readonly budget: BudgetPort;
  readonly personalization: PersonalizationPort;
  readonly flags: StylistFlagPort;
  readonly outfits: Pick<StylistStore, "insertOutfits" | "countSince" | "getStyleVector">;
}

export interface WardrobeDeps {
  readonly store: WardrobeStore;
  readonly images: WardrobeImageStorePort;
  readonly vision: VisionAttributePort;
  readonly consent: WardrobeConsentPort;
  readonly flags: WardrobeFlagPort;
  readonly stylist: StylistPorts;
  readonly clock: Clock;
  readonly ids: IdPort;
  readonly cfg: WardrobeConfig;
}

export const DAY_MS = 86_400_000;
export const startOfUtcDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

export async function flagOn(flags: WardrobeFlagPort | StylistFlagPort, key: string): Promise<boolean> {
  try {
    return await flags.isEnabled(key);
  } catch {
    return false; // fail closed
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export interface ItemView {
  readonly item: WardrobeItem;
  /** True when category, palette, pattern, formality, seasons, material and modest are all set. */
  readonly complete: boolean;
  /** True when a suggestion from the vision port was applied and the shopper has not edited it yet. */
  readonly needsReview: boolean;
}

export type { Attributes };
