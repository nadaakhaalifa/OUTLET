import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";

/** Plan management is platform wide; role gating is the admin rule plus the handler check. */
export class PlusAdminResolver implements ResourceResolver {
  async resolve(): Promise<Resource | null> {
    return { type: "admin_console", id: "plus-plans", state: "active" };
  }
}
