export { createClient } from "./client";
export { ApiError, NetworkError, TimeoutError, AbortedError, ContractDriftError } from "./runtime/errors";
export { paginate, collectPages, type PageLike } from "./runtime/pagination";
export { uuidv7, defaultRandomBytes } from "./runtime/uuidv7";
export type {
  ApiResponse, ApiOk, ApiNotModified, ApiNotImplemented, CallOptions, ClientConfig, ClientEvent, ContractIssue, FetchLike,
} from "./runtime/types";
export { operations, type OperationId, type OperationInput, type OperationOutput, type OutletClient } from "./generated/operations";
export * as schemas from "./generated/schemas";

import type { ApiNotImplemented, ApiResponse } from "./runtime/types";

/** Unwraps a response that cannot be 304 (the caller sent no If-None-Match). */
export function dataOf<T>(res: ApiResponse<T> | ApiNotImplemented): T {
  if ("ok" in res) throw new Error("not_implemented: this operation is planned and has no server route yet (ADR-0050)");
  if (res.notModified) throw new Error("unexpected 304: no If-None-Match was sent");
  return res.data;
}
