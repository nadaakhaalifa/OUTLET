export * from "./canonical";
export * from "./errors";
export * from "./in-memory-store";
export * from "./service";
export * from "./sha256";
export * from "./store";
export * from "./types";

/** Maps an idempotency error to the HTTP status the API layer must return. */
import { IdempotencyError } from "./errors";
export function httpStatusFor(err: unknown): number | undefined {
  if (err instanceof IdempotencyError && "httpStatus" in err && typeof err.httpStatus === "number") {
    return err.httpStatus;
  }
  return undefined;
}
