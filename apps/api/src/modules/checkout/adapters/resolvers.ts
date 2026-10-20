import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { SagaRepository } from "../domain/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checkout group routes: the engine decides on the real owner; unknown and foreign both become 404. */
export class CheckoutGroupResolver implements ResourceResolver {
  constructor(private readonly repo: SagaRepository) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    const id = input.id;
    if (id === undefined || !UUID.test(id)) return null;
    const rec = await this.repo.get(id.toLowerCase());
    return rec === null ? null : { type: "order", id: rec.orderGroupId, ownerUserId: rec.userId, state: "active" };
  }
}
