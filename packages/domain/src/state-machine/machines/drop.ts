import { defineMachine } from "../machine";

export const DROP_STATES = [
  "DRAFT",
  "SCHEDULED",
  "EARLY_ACCESS",
  "LIVE",
  "SOLD_OUT",
  "ENDED",
  "ARCHIVED",
] as const;
export type DropState = (typeof DROP_STATES)[number];

export const DROP_EVENTS = [
  "SCHEDULE",
  "OPEN_EARLY_ACCESS",
  "GO_LIVE",
  "STOCK_EXHAUSTED",
  "WINDOW_CLOSED",
  "ARCHIVE",
  "CANCEL",
] as const;
export type DropEvent = (typeof DROP_EVENTS)[number];

export const dropMachine = defineMachine<DropState, DropEvent>({
  name: "Drop",
  states: DROP_STATES,
  events: DROP_EVENTS,
  initial: "DRAFT",
  terminal: ["ARCHIVED"],
  transitions: {
    DRAFT: { SCHEDULE: { to: "SCHEDULED" }, CANCEL: { to: "ARCHIVED" } },
    SCHEDULED: {
      OPEN_EARLY_ACCESS: { to: "EARLY_ACCESS" },
      GO_LIVE: { to: "LIVE" },
      CANCEL: { to: "ARCHIVED" },
    },
    EARLY_ACCESS: {
      GO_LIVE: { to: "LIVE" },
      STOCK_EXHAUSTED: { to: "SOLD_OUT" },
      WINDOW_CLOSED: { to: "ENDED" },
    },
    LIVE: {
      STOCK_EXHAUSTED: { to: "SOLD_OUT" },
      WINDOW_CLOSED: { to: "ENDED" },
    },
    SOLD_OUT: { ARCHIVE: { to: "ARCHIVED" } },
    ENDED: { ARCHIVE: { to: "ARCHIVED" } },
    ARCHIVED: {},
  },
});
