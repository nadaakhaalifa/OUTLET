import type { AdapterContext } from "../../services/wire";
import { ApiWorldsPort } from "../worlds/api";
import type { StoresDirectoryPort, StoreSummary } from "./model";

/**
 * GET /v1/stores through the same generated operation as the Home list (listStores). The wire has no follow
 * toggle, item counts or a verified-store flag; sorting beyond trending is applied client-side
 * (docs/plan/api-client-gap.md, "Stores directory").
 */
export class ApiStoresDirectoryPort implements StoresDirectoryPort {
  private readonly inner: ApiWorldsPort;
  constructor(ctx: AdapterContext) {
    this.inner = new ApiWorldsPort(ctx);
  }
  listStores(): Promise<readonly StoreSummary[]> {
    return this.inner.listStores();
  }
}
