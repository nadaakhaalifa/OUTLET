import type { z } from "zod";
import { operations, type OperationId, type OutletClient } from "./generated/operations";
import { Problem } from "./generated/schemas";
import { AbortedError, ApiError, ContractDriftError, NetworkError, TimeoutError } from "./runtime/errors";
import type { ApiNotImplemented, ApiResponse, CallOptions, ClientConfig, ClientEvent, ContractIssue } from "./runtime/types";
import { defaultRandomBytes, uuidv7 } from "./runtime/uuidv7";

interface OpDef {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly security: readonly string[];
  readonly idempotency: "none" | "optional" | "required";
  readonly pathParams: readonly string[];
  readonly queryParams: readonly string[];
  readonly headerParams: readonly string[];
  readonly planned: boolean;
  readonly hasBody: boolean;
  readonly responseKind: "json" | "empty" | "binary";
  readonly notModified: boolean;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
}

const SAFE = new Set(["GET", "HEAD"]);
const RETRY_STATUS = new Set([502, 503, 504]);

function issuesOf(err: z.ZodError): ContractIssue[] {
  return err.issues.map((i) => ({ path: i.path.map(String).join("."), code: i.code, message: i.message }));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function serializeQuery(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    if (v === undefined || v === null) continue;
    const vals = Array.isArray(v) ? v : [v];
    for (const x of vals) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(typeof x === "object" ? JSON.stringify(x) : String(x))}`);
  }
  return parts.join("&");
}

/**
 * Typed client with one method per operationId in docs/api/openapi.yaml.
 * - Request input and every response are Zod-parsed; drift throws ContractDriftError.
 * - Write operations that take an Idempotency-Key get a UUIDv7 once per logical call, reused on retry.
 * - Only safe (GET/HEAD) or idempotency-keyed requests are retried (network, timeout, 502/503/504, 429).
 * - One shared refresh on 401; the original request is replayed once with the new token.
 * - No logging: `onEvent` receives the path template and status only, never headers or tokens.
 */
export function createClient(config: ClientConfig): OutletClient {
  const doFetch = config.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let baseEnd = config.baseUrl.length;
  while (baseEnd > 0 && config.baseUrl[baseEnd - 1] === "/") baseEnd -= 1;
  const base = config.baseUrl.slice(0, baseEnd);
  const clock = config.clock ?? (() => Date.now());
  const random = config.random ?? Math.random;
  const randomBytes = config.randomBytes ?? defaultRandomBytes;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const defaultTimeout = config.timeoutMs ?? 10_000;
  const maxRetries = config.maxRetries ?? 2;
  const retryBase = config.retryBaseMs ?? 200;
  const maxRetryDelay = config.maxRetryDelayMs ?? 5_000;
  let refreshing: Promise<string | null> | null = null;

  const refresh = (): Promise<string | null> => {
    if (config.refreshToken === undefined) return Promise.resolve(null);
    if (refreshing === null) {
      const p = config.refreshToken();
      refreshing = p.finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  };

  const emit = (op: OpDef, e: Omit<ClientEvent, "operationId" | "method" | "pathTemplate">): void => {
    config.onEvent?.({ operationId: op.operationId, method: op.method, pathTemplate: op.path, ...e });
  };

  async function invoke(op: OpDef, rawInput: unknown, options: CallOptions | undefined): Promise<ApiResponse<unknown>> {
    const parsedIn = op.input.safeParse(rawInput ?? {});
    if (!parsedIn.success) throw new ContractDriftError(op.operationId, "request", issuesOf(parsedIn.error), null);
    const input = isRecord(parsedIn.data) ? parsedIn.data : {};
    const pathVals = isRecord(input["path"]) ? input["path"] : {};
    const queryVals = isRecord(input["query"]) ? input["query"] : {};
    const headerVals = isRecord(input["headers"]) ? input["headers"] : {};

    let url = base + op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => encodeURIComponent(String(pathVals[name])));
    const qs = serializeQuery(queryVals);
    if (qs !== "") url += `?${qs}`;

    const body = op.hasBody && input["body"] !== undefined ? JSON.stringify(input["body"]) : undefined;
    const idempotencyKey =
      op.idempotency === "none" || SAFE.has(op.method) ? undefined : (options?.idempotencyKey ?? uuidv7(clock(), randomBytes(10)));
    const retryable = SAFE.has(op.method) || idempotencyKey !== undefined;
    const usesBearer = op.security.some((s) => s.endsWith("Bearer"));
    const timeoutMs = options?.timeoutMs ?? defaultTimeout;

    let token: string | null = usesBearer && config.getToken ? await config.getToken() : null;
    let refreshed = false;
    let attempt = 0;

    for (;;) {
      attempt++;
      const started = clock();
      const headers: Record<string, string> = { Accept: "application/json, application/problem+json" };
      Object.assign(headers, config.getHeaders ? await config.getHeaders() : {});
      for (const [k, v] of Object.entries(headerVals)) if (v !== undefined) headers[k] = String(v);
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
      if (token !== null) headers["Authorization"] = `Bearer ${token}`;

      const ctl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, timeoutMs);
      const onUserAbort = (): void => ctl.abort();
      if (options?.signal) {
        if (options.signal.aborted) ctl.abort();
        else options.signal.addEventListener("abort", onUserAbort, { once: true });
      }
      let res: Response;
      let text: string;
      let buf: ArrayBuffer | null = null;
      try {
        const init: RequestInit = { method: op.method, headers, signal: ctl.signal };
        if (body !== undefined) init.body = body;
        res = await doFetch(url, init);
        if (res.status === 304) text = "";
        else if (op.responseKind === "binary" && res.ok) {
          buf = await res.arrayBuffer();
          text = "";
        } else text = await res.text();
      } catch (cause) {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onUserAbort);
        const userAborted = options?.signal?.aborted === true;
        const err = userAborted ? new AbortedError(op.operationId) : timedOut ? new TimeoutError(op.operationId, timeoutMs) : new NetworkError(op.operationId, cause);
        const outcome = userAborted ? "aborted" : timedOut ? "timeout" : "network_error";
        if (!userAborted && retryable && attempt <= maxRetries) {
          emit(op, { attempt, status: null, outcome: "retry", durationMs: clock() - started });
          await sleep(Math.min(maxRetryDelay, retryBase * 2 ** (attempt - 1) * (0.5 + random() / 2)));
          continue;
        }
        emit(op, { attempt, status: null, outcome, durationMs: clock() - started });
        throw err;
      }
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onUserAbort);
      const dur = clock() - started;
      const etag = res.headers.get("ETag");
      const requestId = res.headers.get("X-Request-Id");

      if (res.status === 304 && op.notModified) {
        emit(op, { attempt, status: 304, outcome: "not_modified", durationMs: dur });
        return { notModified: true, status: 304, etag, requestId };
      }

      if (res.status >= 200 && res.status < 300) {
        let payload: unknown = null;
        if (op.responseKind === "json") {
          try {
            payload = JSON.parse(text);
          } catch {
            emit(op, { attempt, status: res.status, outcome: "contract_drift", durationMs: dur });
            throw new ContractDriftError(op.operationId, "response", [{ path: "", code: "invalid_json", message: "body is not valid JSON" }], res.status);
          }
        } else if (op.responseKind === "binary") payload = buf;
        const parsed = op.output.safeParse(payload);
        if (!parsed.success) {
          emit(op, { attempt, status: res.status, outcome: "contract_drift", durationMs: dur });
          throw new ContractDriftError(op.operationId, "response", issuesOf(parsed.error), res.status);
        }
        emit(op, { attempt, status: res.status, outcome: "ok", durationMs: dur });
        return { notModified: false, status: res.status, data: parsed.data, etag, replayed: res.headers.get("Idempotent-Replayed") === "true", requestId };
      }

      // Error responses.
      const ra = Number(res.headers.get("Retry-After"));
      const retryAfter = Number.isFinite(ra) && ra >= 0 && res.headers.get("Retry-After") !== null ? ra : null;

      if (res.status === 401 && token !== null && !refreshed && config.refreshToken !== undefined) {
        refreshed = true;
        const next = await refresh();
        if (next !== null) {
          token = next;
          attempt--;
          continue;
        }
      }

      const transient = RETRY_STATUS.has(res.status) || (res.status === 429 && retryAfter !== null && retryAfter * 1000 <= maxRetryDelay);
      if (retryable && transient && attempt <= maxRetries) {
        emit(op, { attempt, status: res.status, outcome: "retry", durationMs: dur });
        const wait = retryAfter !== null ? retryAfter * 1000 : retryBase * 2 ** (attempt - 1) * (0.5 + random() / 2);
        await sleep(Math.min(maxRetryDelay, wait));
        continue;
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      const prob = Problem.safeParse(json);
      emit(op, { attempt, status: res.status, outcome: "api_error", durationMs: dur });
      if (prob.success) throw new ApiError(op.operationId, res.status, prob.data, true, retryAfter);
      if (res.status < 500 && json !== undefined) {
        throw new ContractDriftError(op.operationId, "problem", issuesOf(prob.error), res.status);
      }
      // Gateway or proxy error without a Problem body: surface a synthesised problem, flagged.
      throw new ApiError(op.operationId, res.status, { type: "about:blank", title: `HTTP ${res.status}`, status: Math.min(599, Math.max(400, res.status)) }, false, retryAfter);
    }
  }

  const client: Record<string, unknown> = {};
  for (const id of Object.keys(operations) as OperationId[]) {
    const op: OpDef = operations[id];
    client[id] = op.planned
      ? (): Promise<ApiNotImplemented> => Promise.resolve({ ok: false, error: "not_implemented" })
      : (input?: unknown, options?: CallOptions) => invoke(op, input, options);
  }
  return client as unknown as OutletClient;
}
