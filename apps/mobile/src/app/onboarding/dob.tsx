import { Redirect } from "expo-router";

/** The date of birth now lives on the single account screen. */
export default function DobRedirect() {
  return <Redirect href="/onboarding/account" />;
}
