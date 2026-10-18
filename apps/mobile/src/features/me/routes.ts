import type { Href } from "expo-router";

/**
 * Destination of the quiet "Sign in" text action (existing accounts only, spec F5). The screen is built by package G3;
 * this is the single place that names the route.
 */
export const SIGN_IN_ROUTE: Href = "/sign-in";

/** "Sell on Z-OUTLET" (spec F1c): the brand path, reached from Me and Settings, never from a launch screen. */
export const SELL_ROUTE: Href = "/brand";
