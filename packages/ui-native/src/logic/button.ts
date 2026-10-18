import type { ColorTokens } from "@outlet/ui-tokens";

/** `primary` is deep teal-black ink. `brand` is the brand teal (identity moments, at most one per screen). */
export type ButtonVariant = "primary" | "brand" | "secondary" | "ghost" | "destructive";

export interface ButtonState {
  readonly variant: ButtonVariant;
  readonly loading: boolean;
  readonly disabled: boolean;
  readonly pressed: boolean;
}

export interface ButtonStyle {
  readonly background: string;
  readonly foreground: string;
  readonly borderColor: string;
  readonly opacity: number;
  /** Press handlers must be ignored. Loading blocks double submits. */
  readonly interactive: boolean;
  readonly accessibilityState: { readonly disabled: boolean; readonly busy: boolean };
}

export function buttonStyle(state: ButtonState, c: ColorTokens): ButtonStyle {
  const inert = state.disabled || state.loading;
  let background: string;
  let foreground: string;
  let borderColor: string;
  switch (state.variant) {
    case "primary":
      background = c.accent; foreground = c.onAccent; borderColor = c.accent; break;
    case "brand":
      background = c.brand; foreground = c.onBrand; borderColor = c.brand; break;
    case "destructive":
      background = c.danger; foreground = c.onDanger; borderColor = c.danger; break;
    case "secondary":
      background = "transparent"; foreground = c.accent; borderColor = c.accent; break;
    case "ghost":
      background = "transparent"; foreground = c.accent; borderColor = "transparent"; break;
  }
  // Disabled is a neutral flat fill with muted text and no ink border, whatever the variant, so a pale primary can
  // never be mistaken for disabled (and vice versa). Loading keeps full strength so the spinner stays legible.
  if (state.disabled && !state.loading) {
    background = state.variant === "ghost" ? "transparent" : c.fill;
    foreground = c.textSecondary;
    borderColor = state.variant === "ghost" ? "transparent" : c.border;
  }
  const opacity = state.disabled ? 0.7 : state.pressed && !inert ? 0.85 : 1;
  return {
    background, foreground, borderColor, opacity,
    interactive: !inert,
    accessibilityState: { disabled: inert, busy: state.loading },
  };
}
