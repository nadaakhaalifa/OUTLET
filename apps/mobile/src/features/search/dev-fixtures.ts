/* eslint-disable @typescript-eslint/no-require-imports -- dev-fixture photography only, behind __DEV__ */
/** DEV-only result photography cropped from the design board. Production builds get null; a real image URL always wins. */
import type { ImageSourcePropType } from "react-native";

export const DEV_SEARCH_PHOTOS: readonly ImageSourcePropType[] | null = __DEV__ ? [
  require("../../../assets/dev-fixtures/board/search-1.png") as ImageSourcePropType,
  require("../../../assets/dev-fixtures/board/search-2.png") as ImageSourcePropType,
  require("../../../assets/dev-fixtures/board/search-3.png") as ImageSourcePropType,
  require("../../../assets/dev-fixtures/board/search-4.png") as ImageSourcePropType,
] : null;
