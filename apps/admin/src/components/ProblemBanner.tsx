import type { Translator } from "@outlet/i18n";
import { problemKey } from "../lib/problem";

/** A blocking, accessible banner for an API Problem. Pages show this instead of data; they never invent stand-ins. */
export function ProblemBanner({ t, code, status }: { t: Translator; code: string; status: number }) {
  return (
    <div className="banner" role="alert" data-code={code}>
      <p>{t(problemKey(code, status))}</p>
    </div>
  );
}
