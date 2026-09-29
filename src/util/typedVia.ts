// Uses zod to make request typing explicit
import type { NextFunction, Request, Response } from "express";
import type { RequestHandler } from "express";
import { z, type ZodType } from "zod";
import { via, type MiddlewareResponse } from "./via.ts";
import { BadRequestError, DeveloperError } from "./errors.ts";

type FieldMap = Record<string, ZodType>;

export interface TypedViaSchema {
  body?: FieldMap;
  params?: FieldMap;
  query?: FieldMap;
  headers?: FieldMap;
}

type InferFields<M> = M extends FieldMap
  ? { [K in keyof M]: z.infer<M[K]> }
  : never;

type InferSchema<S extends TypedViaSchema> = {
  -readonly [
    K in keyof TypedViaSchema as S[K] extends FieldMap ? K : never
  ]-?: InferFields<S[K]>;
};

const SOURCES = ["body", "params", "query", "headers"] as const;

export type TypedRequestHandler<
  S extends TypedViaSchema,
  R extends ZodType | undefined = undefined,
> = RequestHandler & {
  schema: S;
  returnType: R;
  /**
   * Permanently records the handler's response shape as `returnType` and
   * returns the same handler function (now typed with that return type),
   * for chaining or documentation/introspection purposes (e.g. generating
   * an OpenAPI spec later). Can only be called once per handler - calling
   * it again throws DeveloperError rather than silently overwriting the
   * first value, since a route's declared response shape changing out
   * from under callers is a programming mistake, not something to allow.
   */
  returns<NewR extends ZodType>(returnType: NewR): TypedRequestHandler<S, NewR>;
};

/**
 * Like via(), but validates req.body/req.params/req.query/req.headers
 * against per-field Zod schemas before calling the handler. The handler
 * receives the full request, exactly as via()'s own handler would, except
 * that body/params/query/headers (wherever you declared fields for them) are
 * replaced with their validated, typed values - everything else on the
 * request (method, path, session, principal, cookies, etc.) passes through
 * untouched, just like a plain via() handler.
 *
 * A validation failure on any declared source throws a BadRequestError
 * (details: the Zod issues for every failing source), which via's existing
 * Error handling turns into a 400 - same contract as the manual
 * `schema.safeParse(req.body)` pattern used throughout the route files,
 * just without the boilerplate.
 *
 * Unknown/extra fields on a validated source are ignored (z.object's
 * default behavior) - they're simply not part of the inferred type or the
 * value passed to the handler.
 */
export function typedVia<const S extends TypedViaSchema>(
  schema: S,
  handler: (
    arg: Omit<Request, keyof InferSchema<S>> & InferSchema<S>,
    res: Response,
    next: NextFunction,
  ) => MiddlewareResponse,
): TypedRequestHandler<S> {
  const sourceSchemas = Object.fromEntries(
    SOURCES.map((source) => [
      source,
      schema[source] ? z.object(schema[source]) : undefined,
    ]),
  ) as Record<
    (typeof SOURCES)[number],
    ReturnType<typeof z.object> | undefined
  >;

  const handlerFn = via(async (req: Request, res, next) => {
    const issues: Record<string, unknown> = {};
    const typed: Record<string, unknown> = {};

    for (const source of SOURCES) {
      const sourceSchema = sourceSchemas[source];
      if (!sourceSchema) continue;
      const parsed = sourceSchema.safeParse(req[source]);
      if (parsed.success) typed[source] = parsed.data;
      else issues[source] = parsed.error.issues;
    }

    if (Object.keys(issues).length > 0) {
      throw new BadRequestError("invalid request", issues);
    }

    // Everything not part of parameter resolution falls through onto arg
    // unchanged - only the validated sources are overridden. Building a
    // plain object from req's own+inherited enumerable properties (rather
    // than one that shares req's prototype) avoids colliding with Express's
    // getter-only accessors like req.query when applying the overrides.
    const arg: Record<string, unknown> = {};
    for (const key in req) {
      arg[key] = (req as unknown as Record<string, unknown>)[key];
    }
    Object.assign(arg, typed);
    if (typeof req.accepts === "function") {
      // for...in on an IncomingMessage subclass only walks enumerable own
      // properties, not the Request prototype's methods (accepts, header,
      // is, etc.) - rebind the ones handlers actually rely on.
      for (const method of [
        "accepts",
        "acceptsCharsets",
        "acceptsEncodings",
        "acceptsLanguages",
        "get",
        "header",
        "is",
      ] as const) {
        arg[method] = req[method].bind(req);
      }
    }

    return handler(
      arg as Omit<Request, keyof InferSchema<S>> & InferSchema<S>,
      res,
      next,
    );
  });

  const typedHandler = Object.assign(handlerFn, {
    schema,
    returnType: undefined as ZodType | undefined,
    returns(returnType: ZodType) {
      if (typedHandler.returnType !== undefined) {
        throw new DeveloperError(
          "returns() was already called on this handler; a route's return type can only be set once",
        );
      }
      typedHandler.returnType = returnType;
      return typedHandler;
    },
  });

  return typedHandler as TypedRequestHandler<S>;
}
