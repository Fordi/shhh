// Helper to make API discoverable from router
import {
  Router,
  type Router as ExpressRouter,
  type RequestHandler,
} from "express";

const mountsByRouter = new WeakMap<
  ExpressRouter,
  Array<{ prefix: string; router: ExpressRouter }>
>();

/**
 * A drop-in replacement for express.Router() that additionally records the
 * (prefix, subRouter) pairs passed to router.use(prefix, subRouter), so
 * inspectRouter() can reconstruct full route paths without depending on
 * Express's undocumented internal Layer/matcher representation (which,
 * as of Express 5, only lets you confirm a mount prefix you already know,
 * not discover an unknown one - see inspectRouter.ts).
 *
 * Every other method (get/post/put/delete/use with a plain middleware
 * function, etc.) is forwarded to the real Router unchanged; only the
 * router.use(prefix: string, subRouter: Router) overload is intercepted,
 * and only to record the mount - the real .use() call still happens, so
 * request handling behaves identically to a plain Router().
 */
export function TrackedRouter(
  ...args: Parameters<typeof Router>
): ExpressRouter {
  const router = Router(...args);
  mountsByRouter.set(router, []);

  const originalUse = router.use.bind(router);
  router.use = ((...useArgs: Parameters<ExpressRouter["use"]>) => {
    const [maybePrefix, maybeRouter] = useArgs;
    if (typeof maybePrefix === "string" && isExpressRouter(maybeRouter)) {
      mountsByRouter
        .get(router)!
        .push({ prefix: maybePrefix, router: maybeRouter });
    }
    return originalUse(...useArgs);
  }) as ExpressRouter["use"];

  return router;
}

function isExpressRouter(value: unknown): value is ExpressRouter {
  return (
    typeof value === "function" &&
    Array.isArray((value as { stack?: unknown }).stack)
  );
}

/** The (prefix, subRouter) pairs recorded for a TrackedRouter, or [] if `router` wasn't built with TrackedRouter(). */
export function getTrackedMounts(
  router: ExpressRouter,
): Array<{ prefix: string; router: ExpressRouter }> {
  return mountsByRouter.get(router) ?? [];
}

export type { RequestHandler };
