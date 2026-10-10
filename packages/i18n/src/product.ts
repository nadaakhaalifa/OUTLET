/** Single source of the customer-facing product name. Message catalogs use the {{product}} placeholder. */
export const PRODUCT_NAME = "Z-OUTLET";

/** Default interpolation variables every i18n instance must register. */
export const DEFAULT_INTERPOLATION = { product: PRODUCT_NAME } as const;
