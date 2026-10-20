import type { ColorTokens } from "@outlet/ui-tokens";

export interface FieldState {
  readonly error?: string | undefined;
  readonly helper?: string | undefined;
  readonly focused: boolean;
  readonly disabled: boolean;
}

export interface FieldView {
  readonly borderColor: string;
  readonly borderWidth: number;
  /** Message shown under the field: error wins over helper. */
  readonly message: string | null;
  readonly messageColor: string;
  readonly isError: boolean;
  readonly opacity: number;
}

export function fieldView(s: FieldState, c: ColorTokens): FieldView {
  const hasError = typeof s.error === "string" && s.error.length > 0;
  const helper = typeof s.helper === "string" && s.helper.length > 0 ? s.helper : null;
  return {
    borderColor: hasError ? c.danger : s.focused ? c.brand : c.fieldBorder,
    borderWidth: s.focused || hasError ? 2 : 1,
    message: hasError ? (s.error ?? null) : helper,
    // Error text is never colour-only: callers prefix it with an icon/label.
    messageColor: hasError ? c.danger : c.textSecondary,
    isError: hasError,
    opacity: s.disabled ? 0.5 : 1,
  };
}
