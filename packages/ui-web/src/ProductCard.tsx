import type { Locale, MessageKey } from "@outlet/i18n";
import { useI18n } from "./i18n-context.js";
import { Button } from "./Button.js";
import { PriceBlock, type PriceInput } from "./PriceBlock.js";
import { Skeleton } from "./Skeleton.js";
import s from "./ProductCard.module.css";

export type ConditionKey = "newClearance" | "previousSeason" | "openBox" | "cosmeticDefect" | "refurbished" | "nearExpiry" | "sample";
const CONDITION_KEY: Readonly<Record<ConditionKey, MessageKey>> = {
  newClearance: "condition.newClearance",
  previousSeason: "condition.previousSeason",
  openBox: "condition.openBox",
  cosmeticDefect: "condition.cosmeticDefect",
  refurbished: "condition.refurbished",
  nearExpiry: "condition.nearExpiry",
  sample: "condition.sample",
};

export interface ProductCardProps {
  readonly name: string;
  readonly storeName: string;
  readonly href: string;
  readonly image: { readonly src: string; readonly alt: string };
  /** Price and optional verified evidence; the only route to a % off (see PriceBlock). */
  readonly pricing: PriceInput;
  readonly condition?: ConditionKey;
  readonly onQuickAdd?: () => void;
  readonly state?: "ready" | "loading" | "empty" | "error";
  readonly onRetry?: () => void;
  readonly locale?: Locale;
}

export function ProductCard({ name, storeName, href, image, pricing, condition, onQuickAdd, state = "ready", onRetry, locale }: ProductCardProps) {
  const { t, locale: l } = useI18n(locale);
  if (state === "loading") {
    return (
      <div className={s["card"]}>
        <Skeleton blockSize="10rem" locale={l} />
        <Skeleton inlineSize="70%" locale={l} />
        <Skeleton inlineSize="40%" locale={l} />
      </div>
    );
  }
  if (state === "empty") return <div className={s["card"]}><p className={s["muted"]}>{t("state.empty")}</p></div>;
  if (state === "error") {
    return (
      <div className={s["card"]} role="alert">
        <p className={s["muted"]}>{t("error.generic")}</p>
        {onRetry ? <Button variant="secondary" onClick={onRetry}>{t("error.retry")}</Button> : null}
      </div>
    );
  }
  return (
    <article className={s["card"]}>
      <a href={href} className={s["link"]}>
        <img src={image.src} alt={image.alt || name} loading="lazy" className={s["image"]} />
        <span className={s["name"]}>{name}</span>
      </a>
      <span className={s["muted"]}>{t("product.soldBy", { store: storeName })}</span>
      {condition ? <span className={s["chip"]}>{t(CONDITION_KEY[condition])}</span> : null}
      <PriceBlock {...pricing} locale={l} />
      {onQuickAdd ? <Button variant="secondary" aria-label={t("product.quickAdd", { name })} onClick={onQuickAdd}>+</Button> : null}
    </article>
  );
}
