import { Stack } from "expo-router";

export default function OnboardingLayout() {
  // Back gestures are disabled: a refused age check must not be retried by swiping back.
  return <Stack screenOptions={{ headerShown: false, gestureEnabled: false }} />;
}
