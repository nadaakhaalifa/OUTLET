import { HttpException } from "@nestjs/common";
import { AuthError } from "@outlet/auth-core";
import { CatalogError } from "@outlet/catalog";
import { ZodError } from "zod";
import { ProblemError, Problems } from "./problem.js";
import type { ProblemViolation } from "./problem.js";

/** Zod issues to JSON-pointer violations. Messages are not copied (they may echo input); codes are. */
export const violations = (e: ZodError, root: string): ProblemViolation[] =>
  e.issues.slice(0, 50).map((i) => ({ path: `${root}${i.path.map((p) => `/${String(p)}`).join("")}`, code: i.code }));

const fastifyError = (e: unknown): { statusCode: number; code: string } | undefined => {
  if (typeof e !== "object" || e === null) return undefined;
  const statusCode = "statusCode" in e && typeof e.statusCode === "number" ? e.statusCode : undefined;
  const code = "code" in e && typeof e.code === "string" ? e.code : undefined;
  const isSyntax = e instanceof SyntaxError;
  if (statusCode === undefined || !(isSyntax || code?.startsWith("FST_") === true)) return undefined;
  return { statusCode, code: code ?? "SYNTAX" };
};

const catalogProblem = (e: CatalogError): ProblemError => {
  const errors = e.details.map((d) => ({ path: "/body", code: d }));
  switch (e.code) {
    case "not_found":
      return Problems.notFound();
    case "forbidden":
      return Problems.forbidden();
    case "conflict":
      return Problems.conflict("version-conflict");
    case "invalid_transition":
      return Problems.conflict("invalid-transition");
    case "validation":
      return Problems.unprocessable("validation-rule", errors);
    case "activation_blocked":
      return Problems.unprocessable("activation-blocked", errors);
  }
};

/**
 * Every thrown value becomes one Problem. Unknown errors are a bare 500: their message is never sent.
 * Order matters: ProblemError first (already decided), then typed domain errors, then framework errors.
 */
export const toProblem = (e: unknown): ProblemError => {
  if (e instanceof ProblemError) return e;
  if (e instanceof CatalogError) return catalogProblem(e);
  if (e instanceof AuthError) {
    if (e.code === "RATE_LIMITED") return Problems.rateLimited(e.retryAfterSeconds ?? 1);
    return e.code === "ACCESS_TOKEN_INVALID" ? Problems.unauthenticated("invalid-token") : Problems.badRequest("auth-rejected");
  }
  if (e instanceof ZodError) return Problems.validation(violations(e, ""));
  const f = fastifyError(e);
  if (f !== undefined) {
    if (f.statusCode === 413) return Problems.payloadTooLarge();
    if (f.statusCode === 415) return Problems.unsupportedMediaType();
    if (f.statusCode >= 400 && f.statusCode < 500) return Problems.badRequest("malformed-request");
  }
  if (e instanceof HttpException) {
    const status = e.getStatus();
    if (status === 404) return Problems.notFound("route-not-found");
    if (status === 405) return new ProblemError(405, "method-not-allowed", "Method not allowed");
    if (status === 413) return Problems.payloadTooLarge();
    if (status === 415) return Problems.unsupportedMediaType();
    // Our code never throws Nest exceptions: a 4xx HttpException is the framework rejecting the request (e.g. bad JSON).
    if (status >= 400 && status < 500) return Problems.badRequest("malformed-request");
  }
  return Problems.internal();
};
