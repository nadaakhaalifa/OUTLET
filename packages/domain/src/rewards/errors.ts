/** Typed errors of the rewards domain. Callers branch on `code`, never on message text. */
export class RewardsDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RewardsDomainError";
  }
}

export class InvalidRewardsConfigError extends RewardsDomainError {
  constructor(message: string) {
    super("invalid_rewards_config", message);
    this.name = "InvalidRewardsConfigError";
  }
}

export class InvalidOddsTableError extends RewardsDomainError {
  constructor(message: string) {
    super("invalid_odds_table", message);
    this.name = "InvalidOddsTableError";
  }
}

export class InvalidCoinInputError extends RewardsDomainError {
  constructor(message: string) {
    super("invalid_coin_input", message);
    this.name = "InvalidCoinInputError";
  }
}
