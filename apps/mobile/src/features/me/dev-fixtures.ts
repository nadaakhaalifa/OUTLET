/** DEV-only demo profile taken from the design board. Production never reads this: real data only. */
import type { ImageSourcePropType } from "react-native";

export interface DevProfileFixture {
  readonly displayName: string;
  readonly email: string;
  readonly avatar: ImageSourcePropType;
  readonly memberPhoto: ImageSourcePropType;
  /** Payment methods has no route yet (gap recorded in the report); dev shows the row to match the board. */
  readonly paymentMethods: boolean;
}

export function devProfileFixture(): DevProfileFixture | null {
  if (!__DEV__) return null;
  return {
    displayName: "Nada Khalifa",
    email: "nada@example.com",
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    avatar: require("../../../assets/dev-fixtures/board/profile-avatar.png") as ImageSourcePropType,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    memberPhoto: require("../../../assets/dev-fixtures/board/profile-member.png") as ImageSourcePropType,
    paymentMethods: true,
  };
}
