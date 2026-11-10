"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { Locale } from "@outlet/i18n";
import { useI18n } from "./i18n-context.js";
import { Picture, type ArtImage } from "./Picture.js";
import { PriceBlock, type PriceInput } from "./PriceBlock.js";
import type { ConditionKey } from "./ProductCard.js";
import s from "./Village.module.css";

const CONDITION_KEY = {
  newClearance: "condition.newClearance",
  previousSeason: "condition.previousSeason",
  openBox: "condition.openBox",
  cosmeticDefect: "condition.cosmeticDefect",
  refurbished: "condition.refurbished",
  nearExpiry: "condition.nearExpiry",
  sample: "condition.sample",
} as const satisfies Record<ConditionKey, string>;

export const MAX_QUANTITY = 10;

export interface QuickViewPanelProps {
  readonly name: string;
  readonly storeName: string;
  readonly image?: ArtImage;
  readonly pricing: PriceInput;
  readonly condition?: ConditionKey;
  readonly defectCount: number;
  readonly availability: "in_stock" | "low_stock" | "out_of_stock";
  readonly priceProofHref?: string;
  readonly fullPageHref: string;
  /** No-JS close target (the URL without `?p=`); ESC and the close button call `onClose` or navigate here. */
  readonly closeHref: string;
  readonly onClose?: () => void;
  /** No cart exists yet: without this callback the button is disabled and says so. */
  readonly onAddToBag?: (quantity: number) => void;
  readonly locale?: Locale;
}

const FOCUSABLE = 'a[href], button:not([disabled]), summary, input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function QuickViewPanel(props: QuickViewPanelProps) {
  const { name, storeName, image, pricing, condition, defectCount, availability, priceProofHref, fullPageHref, closeHref, onClose, onAddToBag, locale } = props;
  const { t, locale: l } = useI18n(locale);
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [qty, setQty] = useState(1);

  const close = (): void => {
    if (onClose) onClose();
    else window.location.assign(closeHref);
  };

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const soldOut = availability === "out_of_stock";
  const canAdd = onAddToBag !== undefined && !soldOut;
  return (
    <div className={s.dialogRoot}>
      <a className={s.backdrop} href={closeHref} tabIndex={-1} aria-hidden="true" />
      <div ref={panelRef} className={s.panel} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <button ref={closeRef} type="button" className={s.closeBtn} aria-label={t("quickView.close")} onClick={close}>
          <span aria-hidden="true">×</span>
        </button>
        {image ? <Picture image={image} className={s.panelImage} fallbackSize={{ width: 480, height: 480 }} /> : null}
        <h2 id={titleId} className={s.panelTitle}>
          {name}
        </h2>
        <p className={s.muted}>
          {t("quickView.soldBy")}: {storeName}
        </p>
        {condition ? <span className={s.chipTag}>{t(CONDITION_KEY[condition])}</span> : null}
        <PriceBlock {...pricing} locale={l} />
        {availability === "low_stock" ? <p className={s.muted}>{t("product.lowStock")}</p> : null}
        {soldOut ? <p className={s.soldOut}>{t("product.outOfStock")}</p> : null}
        <div className={s.stepper} role="group" aria-label={t("quickView.quantity")}>
          <button type="button" className={s.stepBtn} aria-label={t("quickView.decrease")} disabled={qty <= 1} onClick={() => { setQty((q) => Math.max(1, q - 1)); }}>
            −
          </button>
          <output className={s.qty} aria-live="polite">
            {new Intl.NumberFormat(l).format(qty)}
          </output>
          <button type="button" className={s.stepBtn} aria-label={t("quickView.increase")} disabled={qty >= MAX_QUANTITY} onClick={() => { setQty((q) => Math.min(MAX_QUANTITY, q + 1)); }}>
            +
          </button>
        </div>
        <button type="button" className={s.addBtn} disabled={!canAdd} onClick={() => onAddToBag?.(qty)}>
          {t("quickView.addToBag")}
        </button>
        {onAddToBag === undefined ? <p className={s.muted}>{t("quickView.cartSoon")}</p> : null}
        <details className={s.details}>
          <summary>{t("quickView.conditionWarranty")}</summary>
          <p className={s.muted}>{t("quickView.defects", { count: defectCount })}</p>
          <p className={s.muted}>{t("quickView.warrantyUnknown")}</p>
          {priceProofHref ? (
            <a className={s.link} href={priceProofHref}>
              {t("quickView.priceProof")}
            </a>
          ) : null}
        </details>
        <a className={s.link} href={fullPageHref}>
          {t("quickView.fullPage")}
        </a>
      </div>
    </div>
  );
}
