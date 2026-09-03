/**
 * Declarative config-file Routes (ADR-0002).
 *
 * A JSON file (env PIZZAPI_ROUTES_FILE) declares Routes that are synced into
 * the route table at startup. The file is the source of truth for its routes:
 * they show up read-only in the UI, and removing one from the file removes it
 * from the table on next sync.
 *
 * File shape: { "routes": [ { eventType, target, deliverAs, filters?, ... } ] }
 */

import { readFileSync } from "fs";
import type { RouteInput } from "@pizzapi/protocol";
import { isRouteTarget, isValidEventType } from "@pizzapi/protocol";
import { createLogger } from "@pizzapi/tools";
import { syncConfigRoutes } from "./store.js";
import { resolveSessionRunner } from "../sessions/ownership.js";

const log = createLogger("config-routes");

export function parseRoutesFile(content: string): RouteInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error("Routes file is not valid JSON", { cause: err });
  }
  const routes = (parsed as { routes?: unknown }).routes;
  if (!Array.isArray(routes)) throw new Error('Routes file must have a "routes" array');

  return routes.map((raw, i) => {
    const r = raw as Partial<RouteInput>;
    if (!isValidEventType(r.eventType)) throw new Error(`routes[${i}]: invalid eventType`);
    if (!isRouteTarget(r.target)) throw new Error(`routes[${i}]: invalid target`);
    if (r.deliverAs !== "steer" && r.deliverAs !== "followUp") {
      throw new Error(`routes[${i}]: deliverAs must be "steer" | "followUp"`);
    }
    // Tenant scope: optional. Absent = operator-level (matches every user's
    // events); set it to pin the route to one user's events.
    if (r.ownerUserId !== undefined && (typeof r.ownerUserId !== "string" || r.ownerUserId.length === 0)) {
      throw new Error(`routes[${i}]: ownerUserId must be a non-empty string`);
    }
    return { ...r, eventType: r.eventType, target: r.target, deliverAs: r.deliverAs, origin: "config" as const };
  });
}

/** Load + sync config routes at startup. Missing env/file is a no-op. */
export async function loadConfigRoutes(filePath = process.env.PIZZAPI_ROUTES_FILE): Promise<number> {
  if (!filePath) {
    await syncConfigRoutes([]); // no file = no config routes; clear stale ones
    return 0;
  }
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (err) {
    log.error(`Could not read routes file ${filePath}:`, err);
    return 0; // keep existing config routes rather than wiping on a read error
  }
  const routes = parseRoutesFile(content);
  // Stamp session targets with their runner — same contract as API-created
  // routes. Without it, routeToSubscription returns null and runner reconcile
  // snapshots/deltas never see config-declared routes (and their sessions
  // can't be woken offline).
  const stamped = await Promise.all(
    routes.map(async (r) => {
      if (r.target.kind !== "session" || r.target.runnerId) return r;
      const res = await resolveSessionRunner(r.target.sessionId).catch(() => null);
      return res?.runnerId ? { ...r, target: { ...r.target, runnerId: res.runnerId } } : r;
    }),
  );
  await syncConfigRoutes(stamped);
  log.info(`Synced ${routes.length} config route(s) from ${filePath}`);
  return routes.length;
}
