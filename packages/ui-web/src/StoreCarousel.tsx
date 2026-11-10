"use client";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Locale } from "@outlet/i18n";
import { cx } from "./cx.js";
import { useI18n } from "./i18n-context.js";
import s from "./Village.module.css";

export interface StoreCarouselProps {
  /** Accessible name of the carousel region. */
  readonly label: string;
  readonly children: readonly ReactNode[];
  readonly variant?: "wide" | "cubby" | "card";
  /** Visible hint under the controls (for example "Swipe or drag to discover stores"). */
  readonly hint?: string;
  readonly locale?: Locale;
}

/** Horizontal scroll-snap carousel. Scroll direction follows the document direction; arrows, keys and dots all scroll the same viewport. */
export function StoreCarousel({ label, children, variant = "card", hint, locale }: StoreCarouselProps) {
  const { t, dir } = useI18n(locale);
  const ref = useRef<HTMLUListElement>(null);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(0);
  const sign = dir === "rtl" ? -1 : 1;

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el || el.clientWidth === 0) return;
    setPages(Math.max(1, Math.ceil((el.scrollWidth - 1) / el.clientWidth)));
    setPage(Math.min(Math.max(0, Math.round(Math.abs(el.scrollLeft) / el.clientWidth)), Math.max(0, Math.ceil((el.scrollWidth - 1) / el.clientWidth) - 1)));
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, [measure, children.length]);

  const go = (target: number): void => {
    const el = ref.current;
    if (!el) return;
    const reduce = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: sign * target * el.clientWidth, behavior: reduce ? "auto" : "smooth" });
  };
  const step = (delta: number): void => { go(Math.min(Math.max(page + delta, 0), pages - 1)); };
  const visual = (e: KeyboardEvent): number => (e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0);

  const onKey = (e: KeyboardEvent<HTMLUListElement>): void => {
    const v = visual(e);
    if (v === 0) return;
    e.preventDefault();
    // Visual right moves toward later slides in LTR and earlier ones in RTL.
    step(v * sign);
  };

  const slideClass = cx(s.slide, variant === "wide" && s.slideWide, variant === "cubby" && s.cubbySlide);
  return (
    <div className={s.carousel} role="group" aria-roledescription="carousel" aria-label={label}>
      <ul ref={ref} className={s.viewport} tabIndex={0} aria-label={label} onKeyDown={onKey} onScroll={measure}>
        {children.map((child, i) => (
          <li key={i} className={slideClass}>
            {child}
          </li>
        ))}
      </ul>
      <div className={s.controls}>
        <button type="button" className={s.arrow} aria-label={t("carousel.prev")} disabled={page <= 0} onClick={() => { step(-1); }}>
          <span aria-hidden="true" className={s.arrowIcon}>‹</span>
        </button>
        {pages > 1 ? (
          <div className={s.dots} role="group" aria-label={t("carousel.dots")}>
            {Array.from({ length: pages }, (_, i) => (
              <button key={i} type="button" className={cx(s.dot, i === page && s.dotActive)} aria-label={t("carousel.dot", { n: i + 1 })} {...(i === page ? { "aria-current": "true" as const } : {})} onClick={() => { go(i); }} />
            ))}
          </div>
        ) : null}
        <button type="button" className={s.arrow} aria-label={t("carousel.next")} disabled={page >= pages - 1} onClick={() => { step(1); }}>
          <span aria-hidden="true" className={s.arrowIcon}>›</span>
        </button>
      </div>
      {hint ? <p className={s.hint}>{hint}</p> : null}
    </div>
  );
}
