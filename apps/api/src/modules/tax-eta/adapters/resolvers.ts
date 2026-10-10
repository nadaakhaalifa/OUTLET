import type { Actor, Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { TaxDocumentRepository } from "../domain/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_STORE = "00000000-0000-0000-0000-000000000000";

const INVOICE_ROLES: readonly string[] = ["owner", "manager", "finance"];

/** Stores where the actor passes the `store_payout` read rule (role-capable brand grants only). */
export function storeIdsOf(actor: Actor): string[] {
  const ids = actor.grants.flatMap((g) => (g.kind === "brand" && INVOICE_ROLES.includes(g.role) ? [g.storeId] : []));
  return [...new Set(ids)];
}

/** The seller's invoice list is a collection: the resource is the actor's first payout-capable store (nil store when there is none, then 403). */
export class StoreListResolver implements ResourceResolver {
  async resolve(input: { readonly actor: Actor }): Promise<Resource | null> {
    const first = storeIdsOf(input.actor)[0] ?? NIL_STORE;
    return { type: "store_payout", id: first, storeId: first, state: "active" };
  }
}

/**
 * One invoice. Foreign, missing and non-invoice documents are all `null`, which the guard turns
 * into 404: a seller can never learn that another store's document exists.
 */
export class StoreInvoiceResolver implements ResourceResolver {
  constructor(private readonly docs: TaxDocumentRepository) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const d = await this.docs.findById(input.id.toLowerCase());
    if (d === null || d.stored.storeId === null || d.stored.document.kind !== "seller_einvoice") return null;
    return { type: "store_payout", id: d.stored.id, storeId: d.stored.storeId, state: "active" };
  }
}
