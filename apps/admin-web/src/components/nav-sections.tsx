import Link from "next/link";
import type { Translator } from "../i18n";
import { activeNavId, type NavSection } from "../view-models/nav";

/**
 * Grouped navigation links, each group a collapsible <details> (open by default, no JS needed). Rendered twice
 * (sidebar and phone menu), so `idPrefix` keeps ids unique. The group label is a <summary>, not a heading, so the
 * page keeps a single h1 and the sidebar (before <main> in the DOM) never puts an h2 ahead of it.
 */
export function NavSections({ sections, path, t, idPrefix }: { sections: readonly NavSection[]; path: string; t: Translator; idPrefix: string }) {
  const active = activeNavId(sections.flatMap((s) => s.items), path);
  return (
    <>
      {sections.map((s) => (
        <details key={s.id} open aria-labelledby={`${idPrefix}-${s.id}`} className="nav-group">
          <summary id={`${idPrefix}-${s.id}`} className="nav-heading">{t(s.labelKey)}</summary>
          <ul>
            {s.items.map((i) => (
              <li key={i.id}><Link href={i.href} aria-current={i.id === active ? "page" : undefined}>{t(i.labelKey)}</Link></li>
            ))}
          </ul>
        </details>
      ))}
    </>
  );
}
