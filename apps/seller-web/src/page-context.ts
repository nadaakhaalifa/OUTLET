import { createTranslator, type Locale, type Translator } from "./i18n";
import type { Ctx } from "./loaders";
import { getContext } from "./server-context";

export interface PageCtx {
  readonly ctx: Ctx;
  readonly t: Translator;
  readonly locale: Locale;
}

/** Role is unknown until the API exposes a seller "me"; loaders treat null as "show by status, API enforces". */
export async function pageCtx(): Promise<PageCtx> {
  const c = await getContext();
  return { ctx: { api: c.api, locale: c.locale, role: null, nowMs: Date.now() }, t: createTranslator(c.locale), locale: c.locale };
}
