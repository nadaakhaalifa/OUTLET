/** Public surface of the Checkout gate. Everything else in this folder is private (depcruise `no-sign-up-outside-gate`). */
export { openCheckoutGate, SIGN_UP_ROUTE, MERGE_PHASE_ROUTE, type GateEntryDeps } from "./model";
export { useCheckoutEntry } from "./useCheckoutEntry";
export { CheckoutGateScreen } from "./CheckoutGateScreen";
export { useGateGuard } from "./useGateGuard";
export { gateAccessAllowed, resolveGateAccess, type GateAccessFacts, type GateAccessDeps } from "./access";
