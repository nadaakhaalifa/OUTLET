"use client";

import type { ReactNode } from "react";
import { Dialog } from "./Dialog";

/** "Are you sure?" with the safe choice first and a clearly named action. All labels come translated from the caller. */
export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel, workingLabel, onConfirm, onCancel, pending = false }: { open: boolean; title: string; children: ReactNode; confirmLabel: string; cancelLabel: string; workingLabel: string; onConfirm: () => void; onCancel: () => void; pending?: boolean }) {
  return (
    <Dialog open={open} {...(pending ? {} : { onClose: onCancel })} title={title} actions={<>
      <button type="button" className="btn btnSecondary" onClick={onCancel} disabled={pending}>{cancelLabel}</button>
      <button type="button" className="btn btnPrimary" onClick={onConfirm} disabled={pending}>{pending ? workingLabel : confirmLabel}</button>
    </>}>
      {children}
    </Dialog>
  );
}
