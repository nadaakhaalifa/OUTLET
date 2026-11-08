import type { MessageKey, Translator } from "@outlet/i18n";

const BY_CODE: Readonly<Record<string, MessageKey>> = {
  "passkey-required": "seller.error.passkey",
  unauthenticated: "seller.error.unauthenticated",
  "invalid-token": "seller.error.unauthenticated",
  "store-scope-required": "seller.error.noStore",
  "not-found": "seller.error.notFound",
  forbidden: "seller.error.forbidden",
  "version-conflict": "seller.error.conflict",
  "validation-failed": "seller.error.validation",
  "validation-rule": "seller.error.validation",
  "rate-limited": "seller.error.rate",
};

const keyFor = (code: string, status: number): MessageKey => {
  const hit = BY_CODE[code];
  if (hit !== undefined) return hit;
  if (status === 404) return "seller.error.notFound";
  if (status === 403) return "seller.error.forbidden";
  if (status === 401) return "seller.error.unauthenticated";
  return "error.generic";
};

/** A blocking, accessible banner for an API Problem (the `passkey-required` Problem is the one sellers hit first). */
export function ProblemBanner({ t, code, status }: { t: Translator; code: string; status: number }) {
  return (
    <div className="banner" role="alert" data-code={code}>
      <p>{t(keyFor(code, status))}</p>
    </div>
  );
}
