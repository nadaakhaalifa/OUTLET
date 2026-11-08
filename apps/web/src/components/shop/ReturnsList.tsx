"use client";
import type { Locale } from "@outlet/i18n";
import { Button } from "@outlet/ui-web";
import { browserApi, type ShopperApi } from "../../lib/client-api";
import { returnReasonLabel, returnStatusLabel } from "../../lib/orders-labels";
import { usePaged } from "./Paged";
import { Alert, useShared } from "./shared";

export function ReturnsList({ locale, api = browserApi() }: { readonly locale: Locale; readonly api?: ShopperApi }) {
  const { t, date, base } = useShared(locale);
  const p = usePaged((c) => api.listReturns(c));
  if (p.state === "loading") return <p role="status">{t("returns.list.loading")}</p>;
  if (p.state === "out") return (
    <div className="empty" role="status">
      <p>{t("auth.required")}</p>
      <a className="shopLink" href={`${base}/login?next=${encodeURIComponent(`${base}/returns`)}`}>{t("auth.goLogin")}</a>
    </div>
  );
  if (p.state === "error") return <Alert>{t("returns.list.error")}</Alert>;
  if (p.items.length === 0) return <p className="empty">{t("returns.list.empty")}</p>;
  return (
    <div className="shopStack">
      <ul className="shopList">
        {p.items.map((r) => (
          <li key={r.id} className="shopCard">
            <div className="shopListRow">
              <span className="shopChip shopChipGood">{returnStatusLabel(t, r.status)}</span>
              <span>{returnReasonLabel(t, r.reason_code)}</span>
            </div>
            <p className="hint">{t("returns.list.created", { date: date(r.created_at) })}</p>
            <a className="shopLink" href={`${base}/returns/${r.id}`} aria-label={t("returns.list.open", { date: date(r.created_at) })}>{t("returns.detail.title")}</a>
          </li>
        ))}
      </ul>
      {p.moreError ? <Alert>{t("returns.list.error")}</Alert> : null}
      {p.more ? <Button variant="secondary" loading={p.loadingMore} onClick={p.loadMore}>{t("returns.list.loadMore")}</Button> : null}
    </div>
  );
}
