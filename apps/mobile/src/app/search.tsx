import { useRouter } from "expo-router";
import { SearchScreen } from "../features/search/SearchScreen";

export default function Screen() {
  const router = useRouter();
  return <SearchScreen onOpenProduct={(id) => router.push({ pathname: "/product/[id]", params: { id } })} />;
}
