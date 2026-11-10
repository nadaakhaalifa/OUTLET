export type InventoryErrorCode = "not_found" | "forbidden" | "validation" | "conflict" | "invalid_transition" | "insufficient_stock";

/** Typed inventory failure. HTTP mapping (later): not_found 404, forbidden 403, validation 422, conflict 409, invalid_transition 409, insufficient_stock 409. */
export class InventoryError extends Error {
  constructor(
    readonly code: InventoryErrorCode,
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = "InventoryError";
  }
}

export const notFound = (what: string): InventoryError => new InventoryError("not_found", `${what} not found`);
export const validation = (message: string, details: readonly string[] = []): InventoryError => new InventoryError("validation", message, details);
