export const CREATE_PRODUCT = Symbol("catalog.CreateProduct");
export const GET_SELLER_PRODUCT = Symbol("catalog.GetSellerProduct");
export const LIST_SELLER_PRODUCTS = Symbol("catalog.ListSellerProducts");
export const UPDATE_PRODUCT = Symbol("catalog.UpdateProduct");
export const GET_PUBLIC_PRODUCT = Symbol("catalog.GetPublicProduct");
export const CREATE_IMPORT = Symbol("catalog.CreateImport");
export const GET_IMPORT = Symbol("catalog.GetImport");
export const PRODUCT_RESOLVER = Symbol("catalog.ProductResolver");
export const IMPORT_RESOLVER = Symbol("catalog.ImportResolver");
/** Bundle of the in-memory development fixtures, exported so tests can arrange state. */
export const CATALOG_DEV_FIXTURES = Symbol("catalog.DevFixtures");
