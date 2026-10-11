/**
 * Mapping between the domain account owner kind (packages/domain
 * chart-of-accounts `AccountOwner`) and the persisted
 * `ledger_accounts.owner_type` value (ADR-0018).
 *
 * Persistence keeps `store` and `user` because RLS policies (migration 0007)
 * key on them; the domain says `seller` and `shopper`. Everything else is
 * spelled the same on both sides.
 *
 * The union is redeclared here (not imported) so that @outlet/db does not
 * depend on @outlet/domain at runtime; ledger-owner.test.ts proves the two
 * unions are identical at the type level.
 */
export type DomainAccountOwner =
  | 'platform'
  | 'psp'
  | 'courier'
  | 'bnpl_provider'
  | 'bank'
  | 'seller'
  | 'shopper';

export type PersistedOwnerType =
  | 'platform'
  | 'psp'
  | 'courier'
  | 'bnpl_provider'
  | 'bank'
  | 'store'
  | 'user';

const TO_PERSISTED: Readonly<Record<DomainAccountOwner, PersistedOwnerType>> = {
  platform: 'platform',
  psp: 'psp',
  courier: 'courier',
  bnpl_provider: 'bnpl_provider',
  bank: 'bank',
  seller: 'store',
  shopper: 'user',
};

const TO_DOMAIN: Readonly<Record<PersistedOwnerType, DomainAccountOwner>> = {
  platform: 'platform',
  psp: 'psp',
  courier: 'courier',
  bnpl_provider: 'bnpl_provider',
  bank: 'bank',
  store: 'seller',
  user: 'shopper',
};

export const DOMAIN_ACCOUNT_OWNERS: readonly DomainAccountOwner[] = Object.keys(
  TO_PERSISTED,
) as DomainAccountOwner[];

export const PERSISTED_OWNER_TYPES: readonly PersistedOwnerType[] = Object.keys(
  TO_DOMAIN,
) as PersistedOwnerType[];

export class UnknownLedgerOwnerError extends Error {
  public override readonly name = 'UnknownLedgerOwnerError';
  public constructor(public readonly value: string) {
    super(`unknown ledger owner kind: ${JSON.stringify(value)}`);
  }
}

export const toPersistedOwnerType = (owner: DomainAccountOwner): PersistedOwnerType => TO_PERSISTED[owner];

export const toDomainOwner = (ownerType: PersistedOwnerType): DomainAccountOwner => TO_DOMAIN[ownerType];

/** Validating variants for values read from the database or an API. */
export const parseDomainOwner = (value: string): DomainAccountOwner => {
  if (Object.prototype.hasOwnProperty.call(TO_PERSISTED, value)) return value as DomainAccountOwner;
  throw new UnknownLedgerOwnerError(value);
};

export const parsePersistedOwnerType = (value: string): PersistedOwnerType => {
  if (Object.prototype.hasOwnProperty.call(TO_DOMAIN, value)) return value as PersistedOwnerType;
  throw new UnknownLedgerOwnerError(value);
};
