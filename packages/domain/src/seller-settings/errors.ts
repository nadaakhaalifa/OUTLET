import { DomainError } from "../errors";

/** A settings rule was violated. `code` is a stable machine code the API maps to a Problem+JSON code. */
export class SellerSettingsError extends DomainError {
  constructor(
    readonly code: string,
    message: string = code,
  ) {
    super(message);
  }
}
