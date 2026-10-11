import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import { IdempotencyError, IdempotencyInFlightError, IdempotencyKeyReuseError, InvalidIdempotencyKeyError } from "@outlet/idempotency";
import { toViolations } from "@outlet/validation";
import { ZodError } from "zod";
import type { ApiRequest, ApiResponse } from "./http-types";
import { ProblemError, Problems, problemBody } from "./problem";

const TITLES: Readonly<Record<number, string>> = {
  400: "Bad request",
  401: "Authentication is required",
  403: "You are not allowed to do this",
  404: "Resource not found",
  405: "Method not allowed",
  406: "Not acceptable",
  409: "Conflict",
  413: "Request body too large",
  415: "Unsupported media type",
  422: "Unprocessable request",
  429: "Too many requests",
};

/** Converts every thrown value into one stable Problem+JSON shape. Unknown errors become a bare 500. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger("Problem");

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<ApiRequest>();
    const res = http.getResponse<ApiResponse>();
    const problem = this.toProblem(exception);
    if (problem.status >= 500) {
      // Class name and request id only: messages can embed user data.
      this.logger.error(`${problem.slug} request_id=${req.ctx?.requestId ?? "-"} cause=${causeName(exception)}`);
    }
    if (problem.status === 304) {
      res.status(304).end();
      return;
    }
    for (const [k, v] of Object.entries(problem.options.headers ?? {})) res.setHeader(k, v);
    res.setHeader("Content-Type", "application/problem+json; charset=utf-8");
    res.status(problem.status).end(JSON.stringify(problemBody(problem, req.ctx?.requestId)));
  }

  private toProblem(exception: unknown): ProblemError {
    if (exception instanceof ProblemError) return exception;
    if (exception instanceof ZodError) return Problems.validation(toViolations(exception));
    if (exception instanceof InvalidIdempotencyKeyError) return Problems.invalidIdempotencyKey();
    if (exception instanceof IdempotencyKeyReuseError) return Problems.idempotencyKeyReuse();
    if (exception instanceof IdempotencyInFlightError) return Problems.idempotencyInFlight();
    if (exception instanceof IdempotencyError) {
      // Store failure or uncanonicalisable payload: fail closed.
      const status = "httpStatus" in exception && typeof exception.httpStatus === "number" ? exception.httpStatus : 503;
      return status === 400 ? Problems.malformedBody() : Problems.unavailable("idempotency_unavailable");
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const slug = status === 404 ? "not-found" : status === 400 ? "bad-request" : `http-${status}`;
      return new ProblemError(status, slug, TITLES[status] ?? "Request failed", { code: slug.replace(/-/g, "_") });
    }
    if (isBodyParserError(exception)) return Problems.malformedBody();
    return Problems.internal();
  }
}

function isBodyParserError(e: unknown): boolean {
  return typeof e === "object" && e !== null && "type" in e && typeof e.type === "string" && e.type.startsWith("entity.");
}

function causeName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}
