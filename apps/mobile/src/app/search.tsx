import { useLocalSearchParams, useRouter } from "expo-router";
import { SearchScreen } from "../features/search/SearchScreen";

export default function Screen() {
  const router = useRouter();
  const { q } = useLocalSearchParams<{ q?: string }>();
  return (
    <SearchScreen
      {...(typeof q === "string" ? { initialQuery: q } : {})}
      onClose={() => (router.canGoBack() ? router.back() : router.replace("/"))}
      onVisualSearch={() => router.push("/visual-search")}
      onOpenProduct={(id) => router.push({ pathname: "/product/[id]", params: { id } })}
    />
  );
}
