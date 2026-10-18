/* eslint-disable @typescript-eslint/no-require-imports -- Metro static asset requires, dev fixtures only */
import type { DevImageKey } from "./model";

/** Bundled DEV fixture photographs (cropped from the design board). Used only when banner data is the dev fixture set. */
const HERO: number = require("../../../assets/dev-fixtures/board/home-hero.png") as number;
const PROMO: number = require("../../../assets/dev-fixtures/board/home-promo.png") as number;

export function devImageSource(key: DevImageKey | null, devFixtures: boolean | undefined): number | null {
  if (!__DEV__ || devFixtures !== true || key === null) return null;
  return key === "hero" ? HERO : PROMO;
}

export type DevDeptKey = "women" | "men" | "kids" | "accessories";
const DEPT: Readonly<Record<DevDeptKey, number>> = {
  women: require("../../../assets/dev-fixtures/board/home-cat-women.png") as number,
  men: require("../../../assets/dev-fixtures/board/home-cat-men.png") as number,
  kids: require("../../../assets/dev-fixtures/board/home-cat-kids.png") as number,
  accessories: require("../../../assets/dev-fixtures/board/home-cat-lifestyle.png") as number,
};
export function devDeptImage(d: DevDeptKey, devFixtures: boolean | undefined): number | null {
  return __DEV__ && devFixtures === true ? DEPT[d] : null;
}
