import type { ProblemBody, ContractIssue } from "./types";

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly operationId: string,
    readonly status: number,
    readonly problem: ProblemBody,
    /** False when the body was not valid Problem+JSON (e.g. a gateway page); `problem` is then synthesised. */
    readonly problemValid: boolean,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`${operationId} failed with ${status}${problem.code !== undefined ? ` (${problem.code})` : ""}`);
  }
  get code(): string | undefined {
    return this.problem.code;
  }
  get requestId(): string | undefined {
    return this.problem.request_id;
  }
}

export class NetworkError extends Error {
  override readonly name = "NetworkError";
  constructor(readonly operationId: string, override readonly cause: unknown) {
    super(`${operationId}: network failure`);
  }
}

export class TimeoutError extends Error {
  override readonly name = "TimeoutError";
  constructor(readonly operationId: string, readonly timeoutMs: number) {
    super(`${operationId}: timed out after ${timeoutMs} ms`);
  }
}

export class AbortedError extends Error {
  override readonly name = "AbortedError";
  constructor(readonly operationId: string) {
    super(`${operationId}: aborted`);
  }
}

/** The server (or the caller) disagreed with docs/api/openapi.yaml. Never swallowed. */
export class ContractDriftError extends Error {
  override readonly name = "ContractDriftError";
  constructor(
    readonly operationId: string,
    readonly phase: "request" | "response" | "problem",
    readonly issues: readonly ContractIssue[],
    readonly status: number | null,
  ) {
    super(`${operationId}: ${phase} violates the OpenAPI contract (${issues.length} issue${issues.length === 1 ? "" : "s"}: ${issues.slice(0, 3).map((i) => `${i.path || "<root>"} ${i.code}`).join(", ")})`);
  }
}
