import { DAY, T0 } from "./repository-contract";

/** Start of the UTC hour one day before T0 (the hour the rollup tests write into). */
export const H0_FOR_TESTS = Math.floor((T0 - DAY) / 3_600_000) * 3_600_000;
