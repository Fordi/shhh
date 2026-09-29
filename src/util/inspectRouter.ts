// reflection for express router
import type { Router } from "express";
import type { TypedRequestHandler, TypedViaSchema } from "./typedVia.ts";
import type { ZodType } from "zod";
import { getTrackedMounts } from "./trackedRouter.ts";

export interface DiscoveredRoute {
  method: string;
  path: string;
  schema: TypedViaSchema;
  returnType: ZodType | undefined;
}

function isTypedHandler(
  handle: unknown,
): handle is TypedRequestHandler<TypedViaSchema> {
  return typeof handle === "function" && "schema" in handle;
}

// Express doesn't expose a router's internal layer stack on its public
// `Router` type - this describes just the shape this function reads off it.
interface RouterInternals {
  stack: {
    route?: {
      path: unknown;
      stack: { method: unknown; handle: unknown }[];
    };
  }[];
}

// Collapses a mount-prefix + route-path concatenation like "/downloads" + "/"
// into "/downloads" rather than leaving "/downloads/" - purely cosmetic for
// discovery/docs output, Express itself doesn't care either way at request time.
function normalizePath(path: string): string {
  const collapsed = path.replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

/**
 * Walks a Router built with TrackedRouter() (see trackedRouter.ts) and
 * returns one entry per typedVia()-produced route handler found, with its
 * full path, HTTP method, validation schema, and declared return type - for
 * introspection/discovery tooling (e.g. generating an API reference), not
 * used at request time.
 *
 * Full paths are reconstructed using the (prefix, subRouter) mounts
 * TrackedRouter recorded, not by inspecting Express's internal Layer
 * representation - Express 5 doesn't expose a mount prefix as a plain
 * string on a layer, only an opaque matcher closure that can confirm a
 * prefix you already know, not discover an unknown one. A plain
 * express.Router() (not built via TrackedRouter) simply has no recorded
 * mounts, so nested routers under it won't be recursed into - only its own
 * direct routes are discoverable.
 *
 * Only routes built with typedVia() are discoverable this way; a plain
 * via()/Express handler with no .schema is silently skipped, not reported
 * with empty/guessed values.
 */
export function inspectRouter(router: Router, prefix = ""): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  for (const layer of (router as unknown as RouterInternals).stack) {
    if (layer.route) {
      const routePath = String(layer.route.path);
      for (const routeLayer of layer.route.stack) {
        if (isTypedHandler(routeLayer.handle)) {
          routes.push({
            method: String(routeLayer.method).toUpperCase(),
            path: normalizePath(`${prefix}${routePath}`),
            schema: routeLayer.handle.schema,
            returnType: routeLayer.handle.returnType,
          });
        }
      }
    }
  }

  for (const { prefix: mountPrefix, router: subRouter } of getTrackedMounts(
    router,
  )) {
    routes.push(...inspectRouter(subRouter, `${prefix}${mountPrefix}`));
  }

  return routes;
}
