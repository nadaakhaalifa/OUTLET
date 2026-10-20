import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { PrivacyRequestRepository } from "../domain/ports";

/**
 * Loads an export request so policy decides on real ownership. Another user's export id resolves to
 * a resource owned by someone else and the policy engine answers 404, the same as an unknown id.
 */
export class ExportResourceResolver implements ResourceResolver {
  constructor(private readonly repo: PrivacyRequestRepository) {}

  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined) return null;
    const r = await this.repo.get(input.id);
    if (r === null || r.kind !== "export") return null;
    return { type: "dsar_export", id: r.id, ownerUserId: r.userId, state: "active" };
  }
}
