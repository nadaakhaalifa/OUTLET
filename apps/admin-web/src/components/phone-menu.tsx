"use client";
import { useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

const FOCUSABLE = "a[href],button:not([disabled]),summary,input:not([disabled]),select:not([disabled])";

/**
 * Phone navigation drawer. A native <details>, so it opens and closes with no JS at all; this wrapper only adds
 * Escape-to-close (focus returns to the summary), close-on-link-click, and a Tab loop inside the open drawer.
 * It ships as a normal Next client chunk, which the CSP already allows (script-src 'self' + nonce + strict-dynamic).
 */
export function PhoneMenu({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const close = (): void => {
    const d = ref.current;
    if (d === null) return;
    d.open = false;
    d.querySelector<HTMLElement>("summary")?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDetailsElement>): void => {
    const d = ref.current;
    if (d === null || !d.open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const items = Array.from(d.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el.tagName === "SUMMARY");
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    const active = document.activeElement;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };
  const onClick = (e: MouseEvent<HTMLDetailsElement>): void => {
    if (e.target instanceof Element && e.target.closest("a[href]") !== null) {
      const d = ref.current;
      if (d !== null) d.open = false;
    }
  };
  return (
    <details className="menu" ref={ref} onKeyDown={onKeyDown} onClick={onClick}>
      <summary className="btn ghost">{label}</summary>
      {children}
    </details>
  );
}
