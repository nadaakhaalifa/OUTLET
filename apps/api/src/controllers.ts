import type { Type } from "@nestjs/common";
import { CatalogPublicController } from "./modules/catalog-public/index.js";
import { HealthController } from "./modules/health/index.js";
import { SellerCatalogController } from "./modules/seller-catalog/index.js";
import { SellerListingsController } from "./modules/seller-listings/index.js";

/** The production route table. The route audit, the OpenAPI generator and the negative-authz suite all read this list. */
export const CONTROLLERS: readonly Type[] = [HealthController, CatalogPublicController, SellerListingsController, SellerCatalogController];
