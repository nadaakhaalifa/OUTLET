import { useRouter } from "expo-router";
import { WishlistsScreen } from "../features/wishlists/WishlistsScreen";

export default function Screen() {
  const router = useRouter();
  return (
    <WishlistsScreen
      onBack={() => router.back()}
      onDiscover={() => router.push("/search")}
      onBuy={(productId) => router.push({ pathname: "/product/[id]", params: { id: productId } })}
      onFindSimilar={(title) => router.push({ pathname: "/search", params: { q: title } })}
    />
  );
}
