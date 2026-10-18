/**
 * DEV-only synthetic physical outlets spread over six governorates. Pure and deterministic; composed only by
 * dev-fixtures.ts (which is gated by __DEV__). Names are plainly synthetic ("Demo outlet 07"). Area ids come from
 * egypt-areas.ts; the outlet-to-area placement is demo data and says nothing about real malls.
 */
import { areaById, governorateById } from "./egypt-areas";

export interface DevOutlet {
  readonly id: string;
  readonly name: string;
  readonly rank: number;
  readonly governorateId: string;
  readonly areaId: string;
  readonly city: string;
  readonly distanceKm: number;
  readonly openNow: boolean;
}

/** Cairo 6, Giza 3, Alexandria 2, Qalyubia 2, Red Sea 1, South Sinai 1. */
export const DEV_OUTLET_AREAS: readonly string[] = [
  "maadi", "nasr-city", "new-cairo", "heliopolis", "zamalek", "fifth-settlement",
  "dokki", "6th-october", "sheikh-zayed",
  "smouha", "montaza",
  "obour", "shubra-el-kheima",
  "hurghada",
  "sharm-el-sheikh",
];

export const devOutletId = (n: number): string => `dev-outlet-${String(n).padStart(2, "0")}`;

export function generateDevOutlets(areaIds: readonly string[] = DEV_OUTLET_AREAS): readonly DevOutlet[] {
  return areaIds.map((areaId, i): DevOutlet => {
    const n = i + 1;
    const area = areaById(areaId);
    if (area === undefined) throw new Error(`unknown area id ${areaId}`);
    return {
      id: devOutletId(n),
      name: `Demo outlet ${String(n).padStart(2, "0")}`,
      rank: 10 + n,
      governorateId: area.governorateId,
      areaId,
      city: governorateById(area.governorateId)?.en ?? area.en,
      distanceKm: Math.round((1.5 + ((n * 37) % 300) / 10) * 10) / 10,
      openNow: n % 4 !== 0,
    };
  });
}
