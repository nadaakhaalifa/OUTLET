import type { Locale } from "@outlet/i18n";
import { useId } from "react";
import { useI18n } from "./i18n-context.js";
import s from "./DefectCard.module.css";

export type DefectGrade = "A" | "B" | "C";

export interface DefectPhoto {
  readonly src: string;
  /** Describes what the photo shows (required: defect photos carry meaning). */
  readonly alt: string;
}

export interface DefectCardProps {
  readonly grade: DefectGrade;
  readonly photos: readonly DefectPhoto[];
  readonly description?: string;
  readonly location?: string;
  readonly doesNotAffectOperation?: boolean;
  /** Link to the product passport; only http(s) and site-relative URLs are rendered. */
  readonly passportUrl?: string;
  /** Pre-rendered QR image of the passport link. */
  readonly passportQrSrc?: string;
  readonly locale?: Locale;
}

function safeHref(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, "https://site.invalid");
    return u.protocol === "https:" || u.protocol === "http:" ? href : null;
  } catch {
    return null;
  }
}

export function DefectCard({ grade, photos, description, location, doesNotAffectOperation, passportUrl, passportQrSrc, locale }: DefectCardProps) {
  const { t } = useI18n(locale);
  const titleId = useId();
  const href = safeHref(passportUrl);
  return (
    <section className={s.card} aria-labelledby={titleId}>
      <header className={s.header}>
        <h3 id={titleId} className={s.title}>{t("defect.title")}</h3>
        <span className={s.grade}>{t("defect.grade", { grade })}</span>
      </header>
      {photos.length > 0 ? (
        <ul className={s.photos} aria-label={t("defect.photos")}>
          {photos.map((p) => (
            <li key={p.src}><img src={p.src} alt={p.alt} loading="lazy" className={s.photo} /></li>
          ))}
        </ul>
      ) : (
        <p className={s.muted}>{t("defect.noPhotos")}</p>
      )}
      <p className={s.description}>{description ?? t("defect.noDescription")}</p>
      {location ? <p className={s.muted}>{t("defect.location", { location })}</p> : null}
      {doesNotAffectOperation === true ? <p className={s.note}>{t("defect.doesNotAffect")}</p> : null}
      {href ? (
        <div className={s.passport}>
          {passportQrSrc ? <img src={passportQrSrc} alt={t("defect.passportQrAlt")} width={96} height={96} /> : null}
          <a href={href} className={s.link}>{t("defect.passportLink")}</a>
        </div>
      ) : null}
    </section>
  );
}
