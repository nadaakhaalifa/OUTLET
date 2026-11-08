import type { MessageKey } from "@outlet/i18n";

const BY_CODE: Readonly<Record<string, MessageKey>> = {
  unauthenticated: "admin.error.unauthenticated",
  "invalid-token": "admin.error.unauthenticated",
  forbidden: "admin.error.forbidden",
  "wrong-principal": "admin.error.wrongPrincipal",
  "not-found": "admin.error.notFound",
  "validation-failed": "admin.error.validation",
  "validation-rule": "admin.error.validation",
  "rate-limited": "admin.error.rate",
  "reason-code-required": "admin.error.reasonRequired",
  "api-unavailable": "admin.error.apiDown",
  "api-unconfigured": "admin.error.apiDown",
};

export function problemKey(code: string, status: number): MessageKey {
  const hit = BY_CODE[code];
  if (hit !== undefined) return hit;
  if (status === 404 || status === 405) return "admin.error.routeMissing";
  if (status === 403) return "admin.error.forbidden";
  if (status === 401) return "admin.error.unauthenticated";
  if (status === 503) return "admin.error.apiDown";
  return "admin.error.generic";
}
