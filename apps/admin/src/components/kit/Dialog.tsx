"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/** Centred modal on native <dialog> (focus trap, Esc and inert background from the browser). Omit `onClose` to require a button press. */
export function Dialog({ open, onClose, title, children, actions, role = "alertdialog" }: { open: boolean; onClose?: () => void; title: string; children: ReactNode; actions: ReactNode; role?: "dialog" | "alertdialog" }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();
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
    <dialog ref={ref} className="dialog" role={role} aria-labelledby={titleId} aria-describedby={bodyId} onCancel={(e) => { e.preventDefault(); onClose?.(); }}>
      {open ? (
        <div className="stack">
          <h2 id={titleId} className="panelTitle">{title}</h2>
          <div id={bodyId}>{children}</div>
          <div className="withActions">{actions}</div>
        </div>
      ) : null}
    </dialog>
  );
}
