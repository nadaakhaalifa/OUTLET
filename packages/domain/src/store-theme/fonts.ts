// Curated font allow-list (ADR-0057 decision 5). Sellers never name fonts; they pick a pairing id.
// VERIFY BEFORE LAUNCH VR-ST-01: every licence and every SHA-256 below is a placeholder until the
// family's own licence file is read and the sanitized, subset file is hashed at ingestion.

import type { DisplayWeight } from "./types";

export const PLATFORM_DEFAULT_PAIRING_ID = "platform_default";
/** All-zero digest: never a real file. Replaced at ingestion (VR-ST-01). */
export const PLACEHOLDER_SHA256 = "0".repeat(64);

export interface FontFamily {
  readonly id: string;
  readonly name: string;
  readonly script: "arabic" | "latin";
  /** SPDX id believed correct; not asserted until VR-ST-01 is closed. */
  readonly licenceSpdx: "OFL-1.1" | "Apache-2.0";
  readonly licenceVerified: boolean;
  /** Display-only faces can never be the body face. */
  readonly displayOnly: boolean;
  readonly weights: readonly DisplayWeight[];
  /** VERIFY VR-ST-01: placeholder until ingestion. */
  readonly sha256: string;
}

export interface FontPairing {
  readonly id: string;
  readonly arabicFamilyId: string;
  readonly latinFamilyId: string;
  /** Weights present in BOTH families. */
  readonly weights: readonly DisplayWeight[];
}

const fam = (
  id: string,
  name: string,
  script: "arabic" | "latin",
  weights: readonly DisplayWeight[],
  displayOnly = false,
): FontFamily => ({
  id,
  name,
  script,
  licenceSpdx: "OFL-1.1",
  licenceVerified: false,
  displayOnly,
  weights,
  sha256: PLACEHOLDER_SHA256,
});

const ALL: readonly DisplayWeight[] = ["regular", "medium", "semibold"];

export const FONT_FAMILIES: readonly FontFamily[] = [
  fam("ibm-plex-sans-arabic", "IBM Plex Sans Arabic", "arabic", ALL),
  fam("cairo", "Cairo", "arabic", ALL),
  fam("amiri", "Amiri", "arabic", ["regular"]),
  fam("el-messiri", "El Messiri", "arabic", ALL),
  fam("readex-pro", "Readex Pro", "arabic", ALL),
  fam("inter", "Inter", "latin", ALL),
  fam("nunito", "Nunito", "latin", ALL),
  fam("playfair-display", "Playfair Display", "latin", ALL),
  fam("montserrat", "Montserrat", "latin", ALL),
];

export const FONT_PAIRINGS: readonly FontPairing[] = [
  { id: "plex_inter", arabicFamilyId: "ibm-plex-sans-arabic", latinFamilyId: "inter", weights: ALL },
  { id: "soft_rounded", arabicFamilyId: "cairo", latinFamilyId: "nunito", weights: ALL },
  { id: "editorial_serif", arabicFamilyId: "amiri", latinFamilyId: "playfair-display", weights: ["regular"] },
  { id: "bold_grotesque", arabicFamilyId: "readex-pro", latinFamilyId: "montserrat", weights: ALL },
  { id: "elegant_messiri", arabicFamilyId: "el-messiri", latinFamilyId: "playfair-display", weights: ALL },
];

export const FONT_PAIRING_IDS: readonly string[] = [
  PLATFORM_DEFAULT_PAIRING_ID,
  ...FONT_PAIRINGS.map((p) => p.id),
];

export function findPairing(id: string): FontPairing | undefined {
  return FONT_PAIRINGS.find((p) => p.id === id);
}

export function findFamily(id: string): FontFamily | undefined {
  return FONT_FAMILIES.find((f) => f.id === id);
}

export function isPlaceholderHash(sha256: string): boolean {
  return sha256 === PLACEHOLDER_SHA256;
}

/** Whether a weight is available for a pairing id ("platform_default" supports all). */
export function pairingSupportsWeight(pairingId: string, weight: DisplayWeight): boolean {
  if (pairingId === PLATFORM_DEFAULT_PAIRING_ID) return true;
  return findPairing(pairingId)?.weights.includes(weight) ?? false;
}

/** Registry self-consistency: pairings reference real Arabic+Latin families and shared weights. */
export function registryProblems(): string[] {
  const out: string[] = [];
  for (const p of FONT_PAIRINGS) {
    const a = findFamily(p.arabicFamilyId);
    const l = findFamily(p.latinFamilyId);
    if (a?.script !== "arabic") out.push(`${p.id}: arabic family invalid`);
    if (l?.script !== "latin") out.push(`${p.id}: latin family invalid`);
    for (const w of p.weights) {
      if (!a?.weights.includes(w) || !l?.weights.includes(w)) out.push(`${p.id}: weight ${w} not in both`);
    }
    if (a?.displayOnly === true) out.push(`${p.id}: display-only arabic family`);
  }
  return out;
}
