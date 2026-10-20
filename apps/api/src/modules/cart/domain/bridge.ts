/**
 * Single seam to the pure cart domain (and money) in packages/domain. Only this file imports the
 * shared package for the cart module; everything else in the module imports `./bridge`.
 */
export * from "@outlet/domain";
