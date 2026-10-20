import Link from "next/link";
import { createTranslator, type Locale } from "../i18n";
import { formatDateTime, formatPct } from "../lib/format";
import { pick } from "../lib/localized";
import { entitySegment, productSegment } from "../lib/paths";
import { dropStateKey } from "../view-models/drops";
import { priceView } from "../view-models/price";
import type { ProductSummary, PublicDrop, StoreSummary } from "../view-models/types";
import { Price, PriceBadge } from "./Price";

export function ProductCard({ p, locale }: { p: ProductSummary; locale: Locale }) {
  const t = createTranslator(locale);
  const title = pick(p.title, locale);
  const view = priceView(p.price, undefined);
  return (
    <li>
      <Link className="card" href={`/${locale}/p/${productSegment(p.id)}`}>
        <div className="media">
          {p.image_url === undefined ? null : <img src={p.image_url} alt={title} width={600} height={800} loading="lazy" decoding="async" />}
        </div>
        <div className="meta">
          <h3>{title}</h3>
          <p className="store">{pick(p.store.name, locale)}{p.sponsored ? ` · ${t("product.sponsored")}` : ""}</p>
          <Price view={view} locale={locale} />
          <PriceBadge view={view} locale={locale} />
        </div>
      </Link>
    </li>
  );
}

export function StoreCard({ s, locale }: { s: StoreSummary; locale: Locale }) {
  const t = createTranslator(locale);
  return (
    <li>
      <Link className="panel" href={`/${locale}/s/${encodeURIComponent(entitySegment(s.id, s.slug, s.name.en))}`}>
        <h3>{pick(s.name, locale)}</h3>
        <p>
          <span className="pill">{t(s.kind === "local" ? "stores.kind.local" : "stores.kind.global")}</span>
          {s.verified_badge ? <span className="pill">{t("stores.verified")}</span> : null}
          {s.live_drop ? <span className="pill live">{t("stores.liveDrop")}</span> : null}
        </p>
        {s.max_verified_discount_pct !== null && s.max_verified_discount_pct !== undefined ? (
          <p className="store">{t("stores.maxVerifiedDiscount", { pct: formatPct(s.max_verified_discount_pct, locale) })}</p>
        ) : null}
      </Link>
    </li>
  );
}

export function DropCard({ d, locale }: { d: PublicDrop; locale: Locale }) {
  const t = createTranslator(locale);
  const key = dropStateKey(d.state);
  return (
    <li>
      <Link className="panel" href={`/${locale}/drops/${d.id}`}>
        <h3>{d.title}</h3>
        <p>
          <span className={key === "LIVE" ? "pill live" : "pill"}>{t(`drops.state.${key}`)}</span>
          <span className="pill">{t(`drops.type.${d.type}`)}</span>
          {d.paused ? <span className="pill">{t("drops.paused")}</span> : null}
        </p>
        <p className="store">{t("drops.starts", { time: formatDateTime(d.starts_at, locale) })}</p>
        <p className="store">{t("drops.ends", { time: formatDateTime(d.ends_at, locale) })}</p>
      </Link>
    </li>
  );
}
