export type ShippingErrorCode =
  | "NO_COVERAGE"
  | "OVERWEIGHT"
  | "INVALID_INPUT"
  | "INTERNATIONAL_DISABLED"
  | "INVALID_ADDRESS"
  | "INVALID_TRANSITION"
  | "COURIER_UNAVAILABLE"
  | "not_found"
  | "invalid_state"
  | "forbidden";

/** Typed shipping failure. HTTP: NO_COVERAGE/OVERWEIGHT 422 (never a guessed fee), INVALID_* 422, INTERNATIONAL_DISABLED 409, INVALID_TRANSITION 409, not_found 404, invalid_state 409, forbidden 403. */
export class ShippingError extends Error {
  constructor(
    readonly code: ShippingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ShippingError";
  }
}
