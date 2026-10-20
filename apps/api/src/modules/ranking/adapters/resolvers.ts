import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";

/** Internal console surface. Policy (`admin_console` read) plus the role check in the controller. */
export class RankingAdminResolver implements ResourceResolver {
  async resolve(): Promise<Resource | null> {
    return { type: "admin_console", id: "ranking-v2", state: "active" };
  }
}
