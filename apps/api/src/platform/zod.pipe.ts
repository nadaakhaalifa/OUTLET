import { type PipeTransform } from "@nestjs/common";
import { toViolations } from "@outlet/validation";
import type { z } from "zod";
import { Problems } from "./problem";

/** Parses a request part with a Zod schema at the boundary. Failures become 400 with JSON pointers. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(
    private readonly schema: S,
    private readonly root: "/body" | "/query" | "/params" = "/body",
  ) {}

  transform(value: unknown): z.output<S> {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) throw Problems.validation(toViolations(r.error, this.root));
    return r.data;
  }
}
