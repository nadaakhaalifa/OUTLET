import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";

/** Admin routes authorise against the admin console; role narrowing happens in the controller. */
export class BrandVerificationAdminResolver implements ResourceResolver {
  async resolve(): Promise<Resource | null> {
    return { type: "admin_console", id: "brand-verification", state: "active" };
  }
}
