// Helper function for express request handlers
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { STATUS_CODES } from "node:http";
import { HttpError } from "./errors.ts";
export type QuickResponse = {
  content?: unknown;
  type?: string;
  status?: number;
};
export type NextArg = string | undefined | true | false | QuickResponse | Error;
export type MiddlewareResponse = NextArg | Promise<NextArg>;

export function via(
  handler: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => MiddlewareResponse,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    let result: Awaited<MiddlewareResponse> | unknown;
    try {
      result = await handler(req, res, next);
    } catch (e) {
      result = e;
    }
    if (result === true) {
      return;
    }
    if (result instanceof Error) {
      if (!(result instanceof HttpError)) {
        throw result;
      }
      const status = result.status;
      const message = String(result.message ?? STATUS_CODES[status]);
      const acceptable = (req.headers.accept ?? "text/plain")
        .split(",")
        .map((part) => {
          const respond = part.trim().replace(/q=[\d.]+/g, "");
          return {
            respondWith: respond === "*/*" ? undefined : respond,
            match: new RegExp(
              respond.replace(/\*/g, ".*").replace(/\+/g, "\\+"),
            ),
          };
        });
      const cls = result.constructor.name;
      const type =
        acceptable.find(({ match }) => match.test(cls))?.respondWith ??
        "text/plain";
      if (type === "application/json") {
        res
          .status(status)
          .type(type)
          .send(
            JSON.stringify({
              type: cls,
              status,
              message,
            }),
          );
      }
      res.status(status).type(type).send(`HTTP ${status} ${message}`);
      return;
    }
    if (isQuickResponse(result)) {
      let { content, type, status } = result;
      status ??= content !== undefined ? 200 : 204;
      res.status(status);
      if (status === 204 || content === undefined) {
        res.end();
      } else {
        type ??=
          typeof content === "object" ? "application/json" : "text/plain";
        content =
          type === "application/json"
            ? JSON.stringify(content)
            : String(content);
        res.type(type).send(String(content));
      }
      return;
    }
    next(result);
  };
}

function isQuickResponse(result: unknown): result is QuickResponse {
  if (typeof result !== "object" || result === null) {
    return false;
  }
  const status = "status" in result ? result.status : undefined;
  if (status === 204) {
    return true;
  }
  if (!("content" in result)) {
    return false;
  }
  return status === undefined || typeof status === "number";
}
