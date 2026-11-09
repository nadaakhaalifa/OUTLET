import Link from "next/link";
import type { Translator } from "@outlet/i18n";
import { Icon } from "../kit/Icon";
import type { NavGroup, NavId } from "./navigation";

/**
 * Sidebar / drawer navigation: collapsible groups on native details (no script, keyboard and
 * screen-reader friendly). Groups start open; the group holding the current page can never be
 * collapsed by default. A single-item group renders as a plain link.
 */
export function NavList({ t, base, groups, current, onNavigate }: { t: Translator; base: string; groups: readonly NavGroup[]; current: NavId; onNavigate?: () => void }) {
  return (
    <ul className="navGroups">
      {groups.map((g) => {
        const links = g.items.map((i) => (
          <li key={i.id}>
            <Link className="navItem" href={`${base}${i.path}`} {...(onNavigate ? { onClick: onNavigate } : {})} {...(current === i.id ? { "aria-current": "page" as const } : {})}>
              <Icon name={i.icon} />
              <span>{t(i.key)}</span>
            </Link>
          </li>
        ));
        if (g.items.length === 1 && g.id === "overview") return links[0];
        return (
          <li key={g.id}>
            <details className="navGroup" open>
              <summary className="navGroupTitle">
                <span>{t(g.key)}</span>
                <Icon name="chevron" className="navChevron" />
              </summary>
              <ul className="navGroupItems">{links}</ul>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
