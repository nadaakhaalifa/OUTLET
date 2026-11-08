import { z } from "zod";

export const storeSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
export const productIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const themeSchema = z.enum(["light", "dark"]);
