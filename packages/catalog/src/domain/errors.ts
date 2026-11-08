export type CatalogErrorCode = "not_found" | "forbidden" | "conflict" | "validation" | "invalid_transition" | "activation_blocked";

/** Typed catalog failure. The HTTP layer maps: not_found 404, forbidden 403, conflict 409, validation 422, invalid_transition 409, activation_blocked 422. */
export class CatalogError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

export const notFound = (what: string): CatalogError => new CatalogError("not_found", `${what} not found`);
export const validation = (message: string, details: readonly string[] = []): CatalogError => new CatalogError("validation", message, details);
