import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { AdsStore } from "../domain/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Campaigns belong to a store; a foreign or unknown campaign resolves to `not_owned` (404). */
export class CampaignResolver implements ResourceResolver {
  constructor(private readonly store: AdsStore) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || !UUID.test(input.id)) return null;
    const id = input.id.toLowerCase();
    const c = await this.store.getCampaign(id);
    return c === null ? null : { type: "store_product", id, storeId: c.storeId, state: "active" };
  }
}

export class AdsAdminResolver implements ResourceResolver {
  async resolve(): Promise<Resource | null> {
    return { type: "admin_console", id: "ads-config", state: "active" };
  }
}
