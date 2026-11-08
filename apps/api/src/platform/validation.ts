import { createParamDecorator } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { META } from "./decorators.js";
import type { ContractDef } from "./decorators.js";
import type { ApiRequest, RequestState } from "./http.js";
import { Problems } from "./problem.js";
import { violations } from "./problem-map.js";

const reflector = new Reflector();

const part = (which: "params" | "query" | "body", ctx: ExecutionContext): unknown => {
  const contract = reflector.get<ContractDef | undefined>(META.contract, ctx.getHandler());
  const schema = contract?.[which];
  if (schema === undefined) throw Problems.internal("contract-undeclared");
  const req = ctx.switchToHttp().getRequest<ApiRequest>();
  let raw: unknown = req[which];
  if (which === "params") {
    raw = Object.fromEntries(Object.entries((raw ?? {}) as Record<string, unknown>).filter(([k]) => k !== "market"));
  }
  const r = schema.safeParse(raw ?? {});
  if (!r.success) throw Problems.validation(violations(r.error, `/${which}`));
  return r.data;
};

/** Path parameters (minus `market`) parsed by the contract's `params` schema; 400 with JSON pointers on failure. */
export const Params = createParamDecorator((_: unknown, ctx: ExecutionContext) => part("params", ctx));
/** Query string parsed by the contract's strict `query` schema. */
export const Query = createParamDecorator((_: unknown, ctx: ExecutionContext) => part("query", ctx));
/** JSON body parsed by the contract's strict `body` schema (unknown fields → 400). */
export const Body = createParamDecorator((_: unknown, ctx: ExecutionContext) => part("body", ctx));
/** The request state (market, principal, store, db context). */
export const Ctx = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestState => ctx.switchToHttp().getRequest<ApiRequest>().ctx);
