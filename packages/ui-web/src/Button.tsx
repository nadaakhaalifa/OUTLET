import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.js";
import s from "./Button.module.css";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly variant?: "primary" | "secondary" | "ghost";
  /** Shows a busy state and blocks clicks. The caller supplies the accessible name through children or aria-label. */
  readonly loading?: boolean;
  readonly children: ReactNode;
}

export function Button({ variant = "primary", loading = false, disabled, className, type = "button", children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx(s.button, s[variant], className)}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
    >
      {children}
    </button>
  );
}
