/**
 * Shared types for modular API routers.
 *
 * Each router is a plain async function that inspects the request path and
 * returns a `Response` when matched, or `undefined` to let the dispatcher
 * try the next router.
 */

/** Handler signature that all domain routers implement. */
export type RouteHandler = (req: Request, url: URL) => Promise<Response | undefined>;
