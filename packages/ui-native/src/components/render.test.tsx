import { describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { expand, find, text } from "../testing/shallow";

vi.mock("react", async () => {
  const actual: Record<string, unknown> = await vi.importActual("react");
  const stubs = {
    useState: (v: unknown) => [v, () => undefined],
    useMemo: (f: () => unknown) => f(),
    useCallback: (f: unknown) => f,
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useRef: (v: unknown) => ({ current: v }),
    useContext: () => null,
  };
  return { ...actual, ...stubs, default: { ...actual, ...stubs } };
});
vi.mock("react-native", () => {
  const host = (name: string) => name;
  return {
    View: host("View"), Text: host("RNText"), Pressable: host("Pressable"), ScrollView: host("ScrollView"), Modal: host("Modal"),
    TextInput: host("TextInput"), ActivityIndicator: host("ActivityIndicator"), RefreshControl: host("RefreshControl"), KeyboardAvoidingView: host("KeyboardAvoidingView"),
    StyleSheet: { hairlineWidth: 1, absoluteFill: { position: "absolute" }, create: <T,>(s: T) => s, flatten: (s: unknown) => s },
    Platform: { OS: "ios", select: <T,>(o: { ios?: T; default?: T }) => o.ios ?? o.default },
    Dimensions: { get: () => ({ width: 390, height: 844, fontScale: 1, scale: 3 }) },
    I18nManager: { isRTL: false },
    useColorScheme: () => "light",
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 3 }),
    AccessibilityInfo: { isReduceMotionEnabled: async () => false, isReduceTransparencyEnabled: async () => false, addEventListener: () => ({ remove: () => undefined }) },
  };
});
vi.mock("expo-blur", () => ({ BlurView: "BlurView" }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
vi.mock("react-native-gesture-handler", () => ({ Gesture: {}, GestureDetector: "GestureDetector", GestureHandlerRootView: "GHRV" }));
vi.mock("expo-image", () => ({ Image: "Image" }));
vi.mock("expo-haptics", () => ({
  impactAsync: async () => undefined, selectionAsync: async () => undefined, notificationAsync: async () => undefined,
  ImpactFeedbackStyle: { Light: "light" }, NotificationFeedbackType: { Success: "success" },
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: Object.assign("Ionicons", { glyphMap: {} }) }));
vi.mock("react-native-reanimated", () => {
  const A = { View: "AView", Text: "AText", ScrollView: "AScrollView", createAnimatedComponent: (c: unknown) => c };
  return {
    default: A, Easing: { bezier: () => () => 0, out: (f: unknown) => f, cubic: () => 0, ease: () => 0, linear: () => 0, inOut: (f: unknown) => f },
    Extrapolation: { CLAMP: "clamp" }, interpolate: () => 0, runOnJS: <T,>(f: T) => f,
    useAnimatedStyle: (f: () => unknown) => f(), useSharedValue: <T,>(v: T) => ({ value: v }),
    withTiming: <T,>(v: T) => v, withSpring: <T,>(v: T) => v, withDelay: (_d: number, v: unknown) => v, withRepeat: (v: unknown) => v,
    useAnimatedScrollHandler: () => ({}), useAnimatedReaction: () => undefined, FadeInDown: { duration: () => ({ delay: () => ({}) }) },
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }) }));

import { StoreName, Badge, PriceBlock, ImageSlot, ProductCard, Avatar, StoreCard, Rating } from "./commerce";
import { Text, Icon, Divider, Eyebrow } from "./primitives";
import { Card, SectionHeader, ListRow, Banner, EmptyState, ErrorState, LoadingState } from "./layout";
import { useTheme } from "../theme";

describe("theme without a provider", () => {
  it("returns a stable light compact theme", () => {
    const t = useTheme();
    expect(t.scheme).toBe("light");
    expect(t.isRTL).toBe(false);
    expect(t.direction).toBe("ltr");
    expect(t.s(10)).toBe(10);
    expect(t.labels.back).toBe("");
  });
});

describe("commerce components", () => {
  it("StoreName shows the verified glyph only when verified is true", () => {
    const yes = expand(h(StoreName, { name: "Nile", verified: true, verifiedLabel: "Verified" }));
    const no = expand(h(StoreName, { name: "Nile", verified: false }));
    expect(text(yes)).toContain("Nile");
    expect(find(yes, (n) => n.props["accessibilityLabel"] === "Verified")).toHaveLength(1);
    expect(find(no, (n) => n.props["accessibilityLabel"] === "Verified")).toHaveLength(0);
  });

  it("Badge labels itself and renders its text", () => {
    const out = expand(h(Badge, { label: "New", kind: "neutral" }));
    expect(find(out, (n) => n.props["accessibilityLabel"] === "New")).toHaveLength(1);
    expect(text(out)).toContain("New");
    expect(text(expand(h(Badge, { label: "Tone", tone: "success" })))).toContain("Tone");
  });

  it("PriceBlock strikes through a reference only for a verified claim, never for a plain price", () => {
    const plain = expand(h(PriceBlock, { priceText: "EGP 800", priceMinor: 80000n }));
    expect(text(plain)).toBe("EGP 800");
    expect(find(plain, (n) => JSON.stringify(n.props["style"] ?? "").includes("line-through"))).toHaveLength(0);
    const launch = expand(h(PriceBlock, { priceText: "EGP 800", priceMinor: 80000n, launch: true, launchLabel: "Launch price" }));
    expect(text(launch)).toContain("Launch price");
  });

  it("ImageSlot renders an image only when a uri is supplied and prefers imageNode", () => {
    expect(find(expand(h(ImageSlot, { imageUri: "https://x/y.jpg", label: "photo" })), (n) => n.type === "Image")).toHaveLength(1);
    expect(find(expand(h(ImageSlot, {})), (n) => n.type === "Image")).toHaveLength(0);
    const withNode = expand(h(ImageSlot, { imageUri: "https://x/y.jpg", imageNode: h("Marker", {}) }));
    expect(find(withNode, (n) => n.type === "Image")).toHaveLength(0);
    expect(find(withNode, (n) => n.type === "Marker")).toHaveLength(1);
  });

  it("ProductCard shows the save button only when a handler exists", () => {
    const base = { title: "Linen dress", priceText: "EGP 900", priceMinor: 90000n };
    const without = expand(h(ProductCard, base));
    const withSave = expand(h(ProductCard, { ...base, onToggleSave: () => undefined, sellerName: "Nile" }));
    expect(text(without)).toContain("Linen dress");
    expect(text(withSave)).toContain("Nile");
    expect(find(withSave, (n) => n.type === "Pressable").length).toBeGreaterThan(find(without, (n) => n.type === "Pressable").length);
  });

  it("Avatar, StoreCard and Rating render their content", () => {
    expect(text(expand(h(Avatar, { name: "Nile Store" })))).not.toBe("");
    expect(text(expand(h(StoreCard, { name: "Nile", meta: "Cairo" })))).toContain("Cairo");
    expect(expand(h(Rating, { value: null, count: null }))).toBeDefined();
    expect(text(expand(h(Rating, { value: 4.5, count: 12, countText: "(12)" })))).toContain("12");
  });
});

describe("primitives and layout", () => {
  it("Text, Eyebrow, Icon and Divider render", () => {
    expect(text(expand(h(Text, { children: "hello" })))).toBe("hello");
    expect(text(expand(h(Eyebrow, { children: "sec" })))).toBe("sec");
    expect(expand(h(Icon, { name: "heart" as never }))).not.toHaveLength(0);
    expect(expand(h(Divider, {}))).not.toHaveLength(0);
  });

  it("Card, SectionHeader, ListRow render their text", () => {
    expect(text(expand(h(Card, { children: h(Text, { children: "inside" }) })))).toBe("inside");
    expect(text(expand(h(SectionHeader, { title: "Sec", actionLabel: "All", onAction: () => undefined })))).toContain("All");
    const row = expand(h(ListRow, { title: "Orders", subtitle: "3 open", value: "x", onPress: () => undefined }));
    expect(text(row)).toContain("Orders");
    expect(text(row)).toContain("3 open");
  });

  it("Banner, EmptyState, ErrorState, LoadingState render messages", () => {
    expect(text(expand(h(Banner, { tone: "warning", message: "Careful" })))).toContain("Careful");
    expect(text(expand(h(EmptyState, { title: "Nothing", description: "Add some", actionTitle: "Go", onAction: () => undefined })))).toContain("Nothing");
    expect(text(expand(h(ErrorState, { title: "Oops", retryTitle: "Retry", onRetry: () => undefined })))).toContain("Retry");
    expect(text(expand(h(LoadingState, { label: "Loading" })))).toContain("Loading");
  });
});
