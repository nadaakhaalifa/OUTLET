export class IdempotencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Key is missing or malformed. Maps to HTTP 400. */
export class InvalidIdempotencyKeyError extends IdempotencyError {
  readonly httpStatus = 400;
}

/** Same key reused with a different request hash. Maps to HTTP 422. */
export class IdempotencyKeyReuseError extends IdempotencyError {
  readonly httpStatus = 422;
}

/** A request with the same key is still in flight. Maps to HTTP 409 (client may retry later). */
export class IdempotencyInFlightError extends IdempotencyError {
  readonly httpStatus = 409;
}

/** Request payload cannot be canonicalised (undefined, NaN, functions, cycles...). */
export class UncanonicalizableRequestError extends IdempotencyError {
  readonly httpStatus = 400;
}

/** The store failed. Callers must fail closed for money/stock writes. Maps to HTTP 503. */
export class IdempotencyStoreError extends IdempotencyError {
  readonly httpStatus = 503;
}
