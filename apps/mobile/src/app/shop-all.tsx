import { useMemo } from "react";
import { useLocalSearchParams } from "expo-router";
import { ShopAllScreen } from "../features/shop-all/ShopAllScreen";
import { normalizeRoute } from "../features/shop-all/listing-model";

const one = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined);

/**
 * /shop-all?store=a,b&category=tops&q=tshirt&min=100&max=500&discount=20&lowest=1&condition=new_with_tags&department=women&free=1&new=1&sort=priceLow
 * (min/max in EGP; `stores` is accepted as an alias of `store`). Bad parts are ignored. The "fits my budget" switch is never a route param.
 */
export default function Screen() {
  const raw = useLocalSearchParams<Record<string, string | string[]>>();
  const flat = useMemo(() => {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = one(v);
    return normalizeRoute(out);
  }, [raw]);
  return <ShopAllScreen initialParams={flat} />;
}
