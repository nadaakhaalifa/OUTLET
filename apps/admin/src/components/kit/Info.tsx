"use client";

import { useId, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

/** An info button that reveals a short plain-language explanation under it. Button name is `label`; text is `children`. */
export function Info({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="info">
      <button type="button" className="infoBtn" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => { setOpen((v) => !v); }}><Icon name="info" /></button>
      {open ? <span id={id} role="note" className="infoPanel">{children}</span> : null}
    </span>
  );
}
