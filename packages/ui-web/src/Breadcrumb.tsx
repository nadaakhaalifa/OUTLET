"use client";
import s from "./Village.module.css";

export interface Crumb {
  readonly label: string;
  /** Last crumb has no href and is the current page. */
  readonly href?: string;
}

export function Breadcrumb({ items, label }: { readonly items: readonly Crumb[]; readonly label: string }) {
  return (
    <nav aria-label={label}>
      <ol className={s.crumbs}>
        {items.map((c, i) => (
          <li key={i}>
            {c.href ? (
              <a className={s.crumbLink} href={c.href}>
                {c.label}
              </a>
            ) : (
              <span aria-current="page">{c.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
