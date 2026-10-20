import { Redirect } from "expo-router";

/** Legacy deep link: the in-store step became the outlets list. */
export default function Screen() {
  return <Redirect href="/stores/outlets" />;
}
