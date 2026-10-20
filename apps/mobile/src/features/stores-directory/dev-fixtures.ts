/** DEV-only store directory fixtures taken from the design board. Production adapters never read this. */
import type { ImageSourcePropType } from "react-native";
import { FIXTURE_STORES, type StoreSummary } from "../worlds/model";
import type { StoreCardExtras } from "./model";
import { generateDevOutlets } from "./dev-outlets";

/** Physical outlets (DEV only). Online shops are the worlds fixtures; these are a separate data set. */
export interface DevDirectoryFixture {
  readonly stores: readonly StoreSummary[];
  readonly extras: Readonly<Record<string, StoreCardExtras & { readonly photo: ImageSourcePropType }>>;
  readonly heroPhoto: ImageSourcePropType;
}

/** DEV-only photos for the chooser cards (online, in-store). */
export function devChooserPhotos(): { readonly online: ImageSourcePropType; readonly inStore: ImageSourcePropType } | null {
  if (!__DEV__) return null;
  return {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    online: require("../../../assets/dev-fixtures/board/home-hero.png") as ImageSourcePropType,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    inStore: require("../../../assets/dev-fixtures/board/stores-hero.png") as ImageSourcePropType,
  };
}

const base = FIXTURE_STORES[0] as StoreSummary;

/** Physical outlet fixtures. Null in production, where outlet data does not exist yet (honest empty state). */
export function devOutletsFixture(): DevDirectoryFixture | null {
  if (!__DEV__) return null;
  const mk = (id: string, name: string, rank: number): StoreSummary => ({ ...base, id, name, kind: "local", status: "active", trendingRank: rank, maxVerifiedDiscountPct: null, rating: null, deliveryDays: null, liveDrop: false, isFavourite: false });
  const demo = generateDevOutlets();
  const photos = [
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../../../assets/dev-fixtures/board/stores-cairo-festival-city.png") as ImageSourcePropType,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../../../assets/dev-fixtures/board/stores-mall-of-arabia.png") as ImageSourcePropType,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../../../assets/dev-fixtures/board/stores-city-stars.png") as ImageSourcePropType,
  ];
  const demoExtras: Record<string, StoreCardExtras & { readonly photo: ImageSourcePropType }> = {};
  demo.forEach((o, i) => {
    demoExtras[o.id] = { city: o.city, country: "Egypt", governorateId: o.governorateId, areaId: o.areaId, openNow: o.openNow, closesAt: "10 PM", distanceKm: o.distanceKm, photo: photos[i % photos.length] as ImageSourcePropType };
  });
  return {
    stores: [mk("dev-cfc", "Cairo Festival City", 1), mk("dev-moa", "Mall of Arabia", 2), mk("dev-cs", "City Stars", 3), ...demo.map((o) => mk(o.id, o.name, o.rank))],
    // Mall to district mapping (governorateId/areaId) is UNVERIFIED (report, mall table): QA seed only.
    extras: {
      ...demoExtras,
      "dev-cfc": { city: "Cairo", country: "Egypt", governorateId: "EG-C", areaId: "new-cairo", openNow: true, closesAt: "10 PM", distanceKm: 2.4,
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        photo: require("../../../assets/dev-fixtures/board/stores-cairo-festival-city.png") as ImageSourcePropType },
      "dev-moa": { city: "Giza", country: "Egypt", governorateId: "EG-GZ", areaId: "6th-october", openNow: true, closesAt: "10 PM", distanceKm: 8.7,
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        photo: require("../../../assets/dev-fixtures/board/stores-mall-of-arabia.png") as ImageSourcePropType },
      "dev-cs": { city: "Cairo", country: "Egypt", governorateId: "EG-C", areaId: "nasr-city", openNow: true, closesAt: "10 PM", distanceKm: 12.1,
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        photo: require("../../../assets/dev-fixtures/board/stores-city-stars.png") as ImageSourcePropType },
    },
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    heroPhoto: require("../../../assets/dev-fixtures/board/stores-hero.png") as ImageSourcePropType,
  };
}
