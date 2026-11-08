import { withDbContext } from "@outlet/db";
import { ShippingError } from "../domain/errors.js";
import { addressSchema, codEligible } from "../domain/address.js";
import { makeEnv } from "./env.js";
import type { Env, ShippingDeps } from "./env.js";

export interface ResolvedAddress {
  /** Most specific first: district, city, governorate. */
  readonly areaIds: readonly string[];
  readonly governorateAreaId: string;
  readonly codEligible: boolean;
}

interface AreaRow { id: string; parent_id: string | null; level: string; code: string }

export class AddressValidator {
  private readonly env: Env;
  constructor(deps: ShippingDeps) {
    this.env = makeEnv(deps);
  }

  /** Zod-validates the structured address, then resolves governorate -> city -> district against geo_areas in one statement and checks the parent chain. */
  async validate(userId: string, raw: unknown): Promise<ResolvedAddress> {
    const parsed = addressSchema.safeParse(raw);
    if (!parsed.success) throw new ShippingError("INVALID_ADDRESS", "address is incomplete or malformed");
    const a = parsed.data;
    const codes = [a.governorateCode, a.cityCode, a.districtCode].filter((c): c is string => c !== undefined);
    if (a.districtCode !== undefined && a.cityCode === undefined) throw new ShippingError("INVALID_ADDRESS", "district needs a city");
    const rows = (
      await withDbContext(this.env.client, { kind: "user", marketId: this.env.marketId, userId }, (tx) =>
        tx.query<AreaRow>("SELECT id, parent_id, level, code FROM geo_areas WHERE market_id = $1 AND active AND code = ANY($2::text[])", [this.env.marketId, codes]),
      )
    ).rows;
    const byCode = new Map(rows.map((r) => [r.code, r] as const));
    const gov = byCode.get(a.governorateCode);
    if (gov?.level !== "governorate") throw new ShippingError("INVALID_ADDRESS", "unknown governorate");
    const chain = [gov];
    for (const [code, level] of [[a.cityCode, "city"], [a.districtCode, "district"]] as const) {
      if (code === undefined) continue;
      const row = byCode.get(code);
      const parent = chain[chain.length - 1];
      if (row?.level !== level || row.parent_id !== parent?.id) throw new ShippingError("INVALID_ADDRESS", `${level} does not belong to its parent`);
      chain.push(row);
    }
    return { areaIds: chain.map((r) => r.id).reverse(), governorateAreaId: gov.id, codEligible: codEligible(a) };
  }
}
