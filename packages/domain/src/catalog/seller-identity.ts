/** Fields the sellers module holds for a store. Only four of them may ever be public (spec B5). */
export interface SellerLegalRecord {
  readonly legalName?: string;
  readonly commercialRegisterNo?: string;
  readonly taxCardNo?: string;
  readonly governorate?: string;
  readonly approved: boolean;
}

export interface PublicSellerIdentity {
  readonly legalName: string;
  readonly commercialRegisterNo: string;
  readonly taxCardNo: string;
  readonly governorate: string;
}

function present(s: string | undefined): s is string {
  return s !== undefined && s.trim().length > 0;
}

/**
 * Allow-list projection. Returns null unless the store is approved and all four fields exist.
 * Constructs a fresh object so no other field of the source record can leak by spreading.
 */
export function publicSellerIdentity(r: SellerLegalRecord | null): PublicSellerIdentity | null {
  if (r === null || !r.approved) return null;
  if (!present(r.legalName) || !present(r.commercialRegisterNo) || !present(r.taxCardNo) || !present(r.governorate)) return null;
  return {
    legalName: r.legalName.trim(),
    commercialRegisterNo: r.commercialRegisterNo.trim(),
    taxCardNo: r.taxCardNo.trim(),
    governorate: r.governorate.trim(),
  };
}
