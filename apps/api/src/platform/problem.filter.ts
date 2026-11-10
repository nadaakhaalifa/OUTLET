import { Catch } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { Logger } from "@outlet/logger";
import type { ApiReply, ApiRequest } from "./http.js";
import { problemBody } from "./problem.js";
import { toProblem } from "./problem-map.js";

const errorName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

/** Global RFC 9457 filter. Logs the error class and code only: messages and stacks can embed personal data. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly log: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<ApiRequest>();
    const reply = http.getResponse<ApiReply>();
    const problem = toProblem(exception);
    const requestId = (req as Partial<ApiRequest>).ctx?.requestId ?? "unknown";
    const log = (req as Partial<ApiRequest>).ctx?.log ?? this.log;
    if (problem.status >= 500) log.error("request failed", { status: problem.status, code: problem.code, error: errorName(exception) });
    else log.debug("request rejected", { status: problem.status, code: problem.code });
    if (reply.sent) return;
    for (const [k, v] of Object.entries(problem.options.headers ?? {})) void reply.header(k, v);
    void reply.header("cache-control", "no-store").type("application/problem+json; charset=utf-8").status(problem.status).send(JSON.stringify(problemBody(problem, requestId)));
  }
}
