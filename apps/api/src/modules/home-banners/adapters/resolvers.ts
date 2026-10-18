import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";

/** One console surface; role checks (marketing, ops) happen in the controller after policy. */
export class HomeBannerAdminResolver implements ResourceResolver {
  async resolve(): Promise<Resource | null> {
    return { type: "admin_console", id: "home-banners", state: "active" };
  }
}
