"use client";
import type { Locale } from "@outlet/i18n";
import { Button } from "@outlet/ui-web";
import { browserApi, type ShopperApi } from "../../lib/client-api";
import { orderStatusLabel } from "../../lib/orders-labels";
import { usePaged } from "./Paged";
import { Alert, useShared } from "./shared";

export function OrdersList({ locale, api = browserApi() }: { readonly locale: Locale; readonly api?: ShopperApi }) {
  const { t, money, date, base } = useShared(locale);
  const p = usePaged((c) => api.listOrders(c));
  if (p.state === "loading") return <p role="status">{t("orders.list.loading")}</p>;
  if (p.state === "out") return (
    <div className="empty" role="status">
      <p>{t("auth.required")}</p>
      <a className="shopLink" href={`${base}/login?next=${encodeURIComponent(`${base}/orders`)}`}>{t("auth.goLogin")}</a>
    </div>
  );
  if (p.state === "error") return <Alert>{t("orders.list.error")}</Alert>;
  if (p.items.length === 0) return <p className="empty">{t("orders.list.empty")}</p>;
  return (
    <div className="shopStack">
      <ul className="shopList" aria-label={t("orders.list.nav")}>
        {p.items.map((o) => (
          <li key={o.id} className="shopCard">
            <div className="shopListRow">
              <span className="shopChip shopChipGood">{orderStatusLabel(t, o.status)}</span>
              <strong>{money(o.total)}</strong>
            </div>
            <p className="hint">{t("orders.list.stores", { count: o.store_count })}{o.placed_at === null ? null : ` · ${t("orders.list.placed", { date: date(o.placed_at) })}`}</p>
            <a className="shopLink" href={`${base}/orders/${o.id}`} aria-label={t("orders.list.open", { total: money(o.total) })}>{t("orders.detail.title")}</a>
          </li>
        ))}
      </ul>
      {p.moreError ? <Alert>{t("orders.list.error")}</Alert> : null}
      {p.more ? <Button variant="secondary" loading={p.loadingMore} onClick={p.loadMore}>{t("orders.list.loadMore")}</Button> : null}
    </div>
  );
}
