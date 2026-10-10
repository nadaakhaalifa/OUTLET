/**
 * Single seam to the pure domain package (money, state machines, fulfillment rules). Only this file
 * imports the shared package for the fulfillment module; everything else imports `./bridge`.
 */
export * from "@outlet/domain";
