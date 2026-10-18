import { useRouter } from "expo-router";
import { WishlistsScreen } from "../../features/wishlists/WishlistsScreen";

/** Saved tab (ADR-0044): the wishlists screen. /wishlists still opens the same screen as a pushed route. */
export default function Screen() {
  const router = useRouter();
  return (
    <WishlistsScreen
      onDiscover={() => router.navigate("/explore")}
      onBuy={(productId) => router.push({ pathname: "/product/[id]", params: { id: productId } })}
      onViewBag={() => router.navigate("/bag")}
      onFindSimilar={(title) => router.push({ pathname: "/search", params: { q: title } })}
    />
  );
}
