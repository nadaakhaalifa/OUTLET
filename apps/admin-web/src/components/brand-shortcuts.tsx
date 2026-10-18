"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { moveSelection, resolveShortcut, SHORTCUTS } from "../view-models/brand-review";
import type { BrandLabels } from "../view-models/brand-labels";

export const BRAND_SHORTCUT_EVENT = "brand-shortcut";

/**
 * Single-key shortcuts for the review console. Ignored while typing, with modifiers, or with a dialog open. On the
 * queue, j/k move focus between row links. On the detail page the action keys are re-dispatched as a window event
 * that the actions panel handles, so a disabled action stays disabled (the panel decides, then the API).
 */
export function BrandShortcuts({ scope, labels, mineHref, queueHref }: {
  readonly scope: "queue" | "detail";
  readonly labels: BrandLabels;
  readonly mineHref: string;
  readonly queueHref: string;
}) {
  const router = useRouter();
  const [help, setHelp] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const index = useRef(-1);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (help && !d.open) d.showModal();
    if (!help && d.open) d.close();
  }, [help]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      const id = resolveShortcut({
        key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey,
        targetTag: t?.tagName ?? "", targetEditable: t?.isContentEditable ?? false,
        dialogOpen: document.querySelector("dialog[open]") !== null,
      }, scope);
      if (id === null) return;
      if (id === "help") { e.preventDefault(); setHelp(true); return; }
      if (id === "mine") { e.preventDefault(); router.push(mineHref); return; }
      if (id === "queue") { e.preventDefault(); router.push(queueHref); return; }
      if (scope === "queue" && (id === "next" || id === "prev")) {
        e.preventDefault();
        const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("[data-row-link]"));
        const current = links.findIndex((l) => l === document.activeElement);
        index.current = moveSelection(current >= 0 ? current : index.current, links.length, id);
        links[index.current]?.focus();
        return;
      }
      if (scope === "queue" && id === "open") {
        const a = document.activeElement;
        if (a instanceof HTMLAnchorElement && a.hasAttribute("data-row-link")) { e.preventDefault(); a.click(); }
        return;
      }
      if (scope === "detail") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(BRAND_SHORTCUT_EVENT, { detail: id }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scope, router, mineHref, queueHref]);

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="sc-title" onClose={() => setHelp(false)}>
      <h2 id="sc-title">{labels["brand.sc.title"]}</h2>
      <dl>
        {SHORTCUTS.filter((s) => s.scope === "both" || s.scope === scope).map((s) => (
          <div className="kv" key={s.id}><dt><kbd dir="ltr">{s.key}</kbd></dt><dd>{labels[s.labelKey as keyof BrandLabels] ?? s.labelKey}</dd></div>
        ))}
      </dl>
      <div className="row end"><button type="button" className="btn" onClick={() => setHelp(false)}>{labels["brand.sc.close"]}</button></div>
    </dialog>
  );
}
