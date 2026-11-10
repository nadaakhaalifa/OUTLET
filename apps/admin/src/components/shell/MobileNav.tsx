"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createTranslator, type Locale } from "@outlet/i18n";
import { Icon } from "../kit/Icon";
import { NavList } from "./NavList";
import { tabItems, type NavGroup, type NavId } from "./navigation";

/** Phones: the "Menu" tab opens the full navigation as a drawer on native dialog (focus trap and Esc from the browser). */
export function MobileNav({ locale, base, groups, current, drawerInfo }: { drawerInfo?: ReactNode; locale: Locale; base: string; groups: readonly NavGroup[]; current: NavId }) {
  const inTabs = tabItems(groups).some((i) => i.id === current);
  const t = createTranslator(locale);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (typeof d.showModal !== "function") {
      if (open) d.setAttribute("open", "");
      else d.removeAttribute("open");
      return;
    }
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <>
      <button type="button" className="tab" {...(inTabs ? {} : { "data-active": "" })} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true); }}>
        <Icon name="menu" />
        <span className="tabLabel">{t("admin.nav.menu")}</span>
      </button>
      <dialog ref={ref} className="drawer" aria-label={t("admin.nav.menuTitle")} onCancel={(e) => { e.preventDefault(); setOpen(false); }} onClose={() => { setOpen(false); }}>
        <div className="drawerHead">
          <h2 className="panelTitle">{t("admin.nav.menuTitle")}</h2>
          <button type="button" className="btn btnGhost" onClick={() => { setOpen(false); }} aria-label={t("admin.nav.close")}>
            <Icon name="close" />
          </button>
        </div>
        {open && drawerInfo !== undefined ? <div className="drawerInfo">{drawerInfo}</div> : null}
        <nav aria-label={t("admin.nav.label")}>
          <NavList t={t} base={base} groups={groups} current={current} onNavigate={() => { setOpen(false); }} />
        </nav>
      </dialog>
    </>
  );
}
