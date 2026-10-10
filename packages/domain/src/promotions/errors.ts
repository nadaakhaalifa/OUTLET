import { DomainError } from "../errors";

export class InvalidPromotionError extends DomainError {
  constructor(readonly issues: readonly string[]) {
    super(`invalid promotion: ${issues.join(", ")}`);
  }
}
