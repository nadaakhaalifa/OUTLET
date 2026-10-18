"use client";
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Wrap Tab / Shift+Tab inside the dialog. Native modal dialogs keep the page inert but let focus exit to browser chrome. */
export function nextFocusTarget(items: readonly HTMLElement[], active: Element | null, shift: boolean): HTMLElement | null {
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) return null;
  if (shift && (active === first || !items.some((i) => i === active))) return last;
  if (!shift && (active === last || !items.some((i) => i === active))) return first;
  return null;
}

/** The part of HTMLDialogElement the controller uses (lets the close logic be tested without a DOM). */
export interface DialogEl { open: boolean; showModal(): void; close(): void }

/**
 * Keeps the native dialog and the parent's `open` prop in step and reports each close exactly once:
 * - a close the parent asked for (open turned false) does not call `onClose` back;
 * - a close the user did (Escape, close button) calls it once, however many native events follow;
 * - if the parent keeps `open` true after a user close, the dialog is re-opened (`defer` runs after the parent's update).
 */
export function createDialogController(el: DialogEl, o: { getOpen: () => boolean; onClose: () => void; defer: (fn: () => void) => void }) {
  let programmatic = false;
  return {
    sync(open: boolean): void {
      if (open && !el.open) el.showModal();
      if (!open && el.open) { programmatic = true; el.close(); }
    },
    /** Close button: close natively so Escape and the button share one path (the native close event). */
    requestClose(): void {
      if (el.open) el.close();
      else o.onClose();
    },
    /** Native `close` event. */
    handleNativeClose(): void {
      if (programmatic) { programmatic = false; return; }
      o.onClose();
      o.defer(() => { if (o.getOpen() && !el.open) el.showModal(); });
    },
  };
}

/**
 * Modal dialog on the native <dialog> element: showModal() gives a real focus trap (the rest of the page is inert),
 * Escape to close, return of focus to the opener, and top-layer rendering, with no JS focus loop to get wrong.
 * `onClose` fires once per user close (Escape or the close button); the parent owns `open`.
 */
export function Dialog({ open, onClose, title, closeLabel, children }: { open: boolean; onClose: () => void; title: string; closeLabel: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const ctl = useRef<ReturnType<typeof createDialogController> | null>(null);
  const openRef = useRef(open);
  const onCloseRef = useRef(onClose);
  openRef.current = open;
  onCloseRef.current = onClose;
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    ctl.current = createDialogController(d, {
      getOpen: () => openRef.current,
      onClose: () => onCloseRef.current(),
      defer: (fn) => { timer = setTimeout(fn, 0); },
    });
    ctl.current.sync(openRef.current);
    return () => { if (timer !== undefined) clearTimeout(timer); ctl.current = null; };
  }, []);
  useEffect(() => { ctl.current?.sync(open); }, [open]);
  const trap = (e: KeyboardEvent<HTMLDialogElement>): void => {
    if (e.key !== "Tab") return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    const target = nextFocusTarget(items, document.activeElement, e.shiftKey);
    if (target !== null) { e.preventDefault(); target.focus(); }
  };
  return (
    <dialog ref={ref} className="uw-dialog" aria-labelledby={titleId} onClose={() => ctl.current?.handleNativeClose()} onKeyDown={trap}>
      <div className="uw-dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="uw-btn" onClick={() => (ctl.current === null ? onClose() : ctl.current.requestClose())} aria-label={closeLabel}>{"✕"}</button>
      </div>
      {open ? children : null}
    </dialog>
  );
}
