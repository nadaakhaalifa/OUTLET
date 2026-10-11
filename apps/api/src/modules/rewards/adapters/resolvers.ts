import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";

/** The rewards console is platform wide; role gating is the admin rule plus the handler check. */
export class RewardsAdminResolver implements ResourceResolver {
  async resolve(): Promise<Resource | null> {
    return { type: "admin_console", id: "rewards-config", state: "active" };
  }
}
