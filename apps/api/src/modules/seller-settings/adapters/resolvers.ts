import type { Resource, ResourceType } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Seller routes are addressed by store id. Any well-formed id resolves to a resource of that store
 * and the central policy compares it with the actor's brand grants: a foreign store is `not_owned`
 * and answers 404, identical to a missing store.
 */
export class StoreScopedResolver implements ResourceResolver {
  constructor(private readonly type: ResourceType) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    const id = input.id;
    if (id === undefined || !UUID.test(id)) return null;
    const lower = id.toLowerCase();
    return { type: this.type, id: lower, storeId: lower, state: "active" };
  }
}
