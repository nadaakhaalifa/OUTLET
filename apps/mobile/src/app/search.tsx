import { useLocalSearchParams, useRouter } from "expo-router";
import { visualSearchEntry } from "../features/search/visual-entry";
import { SearchScreen } from "../features/search/SearchScreen";

/** No client flag source exists yet and visual search is not composed in production: unknown means hidden. */
const VISUAL_SEARCH_KILL_OPEN: boolean | null = null;
const spreadVisual = (h: (() => void) | undefined) => (h !== undefined ? { onVisualSearch: h } : {});

export default function Screen() {
  const router = useRouter();
  const { q } = useLocalSearchParams<{ q?: string }>();
  return (
    <SearchScreen
      {...(typeof q === "string" ? { initialQuery: q } : {})}
      onClose={() => (router.canGoBack() ? router.back() : router.replace("/"))}
      {...spreadVisual(visualSearchEntry(VISUAL_SEARCH_KILL_OPEN, () => router.push("/visual-search")))}
      onOpenProduct={(id) => router.push({ pathname: "/product/[id]", params: { id } })}
    />
  );
}
