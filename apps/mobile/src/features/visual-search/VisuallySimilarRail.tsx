import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Skeleton } from "../../ui";
import { getFeaturePorts } from "../../state/ports";
import { ProductTile, Rail } from "../home/parts";
import { toTile, type VisualItem, type VisualSearchPort } from "./model";

const RAIL_LIMIT = 10;

/**
 * "Visually similar" rail on the product page (GET /v1/products/{id}/visually-similar, no upload). It is
 * supplementary: when the list is empty or the call fails it renders nothing instead of an error block.
 */
export function VisuallySimilarRail(props: { productId: string; port?: VisualSearchPort; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const port = useMemo<VisualSearchPort>(() => props.port ?? getFeaturePorts().visualSearch, [props.port]);
  const [items, setItems] = useState<readonly VisualItem[] | "loading">("loading");

  useEffect(() => {
    let alive = true;
    setItems("loading");
    port.similarTo(props.productId, RAIL_LIMIT).then(
      (r) => { if (alive) setItems(r.items.filter((i) => i.productId !== props.productId)); },
      () => { if (alive) setItems([]); },
    );
    return () => { alive = false; };
  }, [port, props.productId]);

  if (items === "loading") {
    return (
      <View accessibilityRole="progressbar" accessibilityLabel={t("visualSearch.railLoading")} style={{ paddingHorizontal: 20, gap: 10 }}>
        <Skeleton width="40%" height={14} />
        <Skeleton height={220} radius={18} />
      </View>
    );
  }
  if (items.length === 0) return null;
  return (
    <Rail itemWidth={172} title={t("visualSearch.railTitle")}>
      {items.map((i) => <ProductTile key={i.productId} product={toTile(i)} width={172} onOpen={props.onOpen} />)}
    </Rail>
  );
}
