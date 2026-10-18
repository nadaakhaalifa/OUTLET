import { Image } from "react-native";
import item1 from "../../../assets/dev-fixtures/board/bag-item1.png";
import item2 from "../../../assets/dev-fixtures/board/bag-item2.png";
import item3 from "../../../assets/dev-fixtures/board/bag-item3.png";

/**
 * Dev-only photo slots (cropped from the design board). Used only when a line carries no imageUrl and only in
 * development builds; production never reaches the require calls.
 */
const SOURCES: Readonly<Record<string, number>> = __DEV__
  ? {
      "b-l1": item1 as number,
      "b-l2": item2 as number,
      "b-l3": item3 as number,
    }
  : {};

export function devImageFor(lineId: string): string | undefined {
  const src = SOURCES[lineId];
  return src === undefined ? undefined : Image.resolveAssetSource(src).uri;
}
