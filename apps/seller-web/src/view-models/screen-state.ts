import type { ApiError, ApiResult } from "../api/client";
import type { MessageKey } from "../i18n";

/** Every screen renders exactly one of these. "ready" is the only state that shows data. */
export type ScreenState<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "offline" }
  | { readonly kind: "not_configured" }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly messageKey: MessageKey; readonly requestId?: string; readonly retryable: boolean; readonly signIn: boolean }
  | { readonly kind: "ready"; readonly data: T; readonly serverNowMs: number | null };

const errorKey = (e: ApiError): MessageKey => {
  switch (e.kind) {
    case "forbidden": return "state.forbidden";
    case "not_found": return "state.notFound";
    case "unauthorized": return "state.sessionExpired";
    case "rate_limited": return "state.rateLimited";
    case "contract": return "state.contract";
    default: return "state.error";
  }
};

export function stateFromError(e: ApiError): ScreenState<never> {
  if (e.kind === "offline") return { kind: "offline" };
  if (e.kind === "not_configured") return { kind: "not_configured" };
  return {
    kind: "error",
    messageKey: errorKey(e),
    ...(e.requestId === undefined ? {} : { requestId: e.requestId }),
    retryable: e.kind === "server" || e.kind === "rate_limited" || e.kind === "contract",
    signIn: e.kind === "unauthorized",
  };
}

export function stateFromResult<T, V>(
  r: ApiResult<T>,
  toData: (data: T) => V,
  isEmpty: (v: V) => boolean = () => false,
): ScreenState<V> {
  if (!r.ok) return stateFromError(r.error);
  const v = toData(r.value.data);
  if (isEmpty(v)) return { kind: "empty" };
  return { kind: "ready", data: v, serverNowMs: r.value.serverNowMs };
}
