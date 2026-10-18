/** Gift card designs mapped onto the campaign art kit (placeholder art until real card artwork exists). */
import type { HeroVariant } from "../../art";
import type { GiftDesign } from "./model";

export const DESIGN_ART: Readonly<Record<GiftDesign, HeroVariant>> = {
  birthday: "drop",
  eid: "eid",
  ramadan: "ramadan",
  wedding: "plus",
  newBaby: "sale",
  graduation: "drop",
  thankYou: "sale",
};
