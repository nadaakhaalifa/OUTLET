import type { ColorTokens } from "@outlet/ui-tokens";

export type ButtonVariant = "primary" | "secondary" | "destructive";

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
    case "destructive":
      background = c.danger; foreground = c.onDanger; borderColor = c.danger; break;
    case "secondary":
      background = "transparent"; foreground = c.accent; borderColor = c.accent; break;
  }
  // Disabled is dimmed; loading keeps full strength so the spinner stays legible.
  const opacity = state.disabled ? 0.4 : state.pressed && !inert ? 0.85 : 1;
  return {
    background, foreground, borderColor, opacity,
    interactive: !inert,
    accessibilityState: { disabled: inert, busy: state.loading },
  };
}
