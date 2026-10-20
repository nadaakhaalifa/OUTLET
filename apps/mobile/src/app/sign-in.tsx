import { QuietSignInScreen } from "../features/quiet-sign-in/QuietSignInScreen";

/** Existing-account sign-in (ADR-0055 F5). Reached from quiet "Sign in" links only; never creates an account. */
export default function Route() {
  return <QuietSignInScreen />;
}
