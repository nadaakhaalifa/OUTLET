import { z } from "zod";
import { validation } from "../domain/errors.js";

/** Keyset cursor: the sort timestamp as UTC text with microseconds (lossless) plus the row id. Opaque to clients. */
const cursorSchema = z.strictObject({ t: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), id: z.uuid() });
export type Cursor = z.infer<typeof cursorSchema>;

export const MAX_PAGE = 50;
export const DEFAULT_PAGE = 20;

export const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify(c)).toString("base64url");

export const decodeCursor = (raw: string | undefined): Cursor | undefined => {
  if (raw === undefined) return undefined;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    throw validation("invalid cursor");
  }
};

export const pageLimit = (limit: number | undefined): number => {
  const l = limit ?? DEFAULT_PAGE;
  if (!Number.isInteger(l) || l < 1 || l > MAX_PAGE) throw validation(`limit must be an integer between 1 and ${String(MAX_PAGE)}`);
  return l;
};

/** SQL snippet that renders a timestamptz column as a lossless cursor string. */
export const tsText = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
