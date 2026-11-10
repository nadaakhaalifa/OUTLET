"use client";
import s from "./Village.module.css";

export interface ChipItem {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly current?: boolean;
}

export function CategoryChips({ items, label }: { readonly items: readonly ChipItem[]; readonly label: string }) {
  return (
    <nav aria-label={label}>
      <ul className={s.chips}>
        {items.map((c) => (
          <li key={c.id}>
            <a className={s.chip} href={c.href} aria-current={c.current === true ? "true" : "false"}>
              {c.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
