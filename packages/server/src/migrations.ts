import { getMigrations } from "better-auth/db";
import { type AuthContext, runWithAuthContext, getKysely } from "./auth.js";
import { ensureRelaySessionTables } from "./sessions/store.js";
import { ensurePushSubscriptionTable } from "./push.js";
import { ensureRunnerRecentFoldersTable } from "./runner-recent-folders.js";
import { ensureUserHiddenModelTable } from "./user-hidden-models.js";
import { ensureUserPreferenceTable } from "./user-preferences.js";
import { ensureExtractedAttachmentTable } from "./attachments/store.js";
import { ensureWebhookTable } from "./webhooks/store.js";
import { ensureEventTables } from "./events/store.js";
import { createRoute, listRoutes, updateRoute, listOwnerlessRoutes, setRouteOwner } from "./events/store.js";
import { getPersistedRelaySessionOwner } from "./sessions/store.js";
import { getRunnerOwner } from "./runner-owner.js";
import { ensureSetupClaimsTable } from "./setup-claims.js";
import { ensureMobileLinkTable } from "./mobile-links.js";
import { ensureNativePushRegistrationTable } from "./push.js";
import { ensureRunnerOwnerTable } from "./runner-owner.js";
import { legacyFiltersFromParams } from "./events/legacy-filters.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("startup");

type BetterAuthMigrationPlan = {
    toBeCreated: Array<{ table: string }>;
    toBeAdded: Array<{ table: string; fields: Record<string, unknown> }>;
};

export function summarizePendingBetterAuthMigrations(plan: BetterAuthMigrationPlan): {
    hasPending: boolean;
    tablesToCreate: number;
    fieldsToAdd: number;
} {
    const tablesToCreate = plan.toBeCreated.length;
    const fieldsToAdd = plan.toBeAdded.reduce((count, tablePatch) => {
        return count + Object.keys(tablePatch.fields).length;
    }, 0);

    return {
        hasPending: tablesToCreate > 0 || fieldsToAdd > 0,
        tablesToCreate,
        fieldsToAdd,
    };
}

/**
 * Run all database migrations (better-auth + custom tables).
 * Idempotent — safe to call on every server boot.
 */
export async function runAllMigrations(context: AuthContext): Promise<void> {
    try {
        await runWithAuthContext(context, async () => {
            const migrationPlan = await getMigrations(context.auth.options);
            const { runMigrations } = migrationPlan;

            const summary = summarizePendingBetterAuthMigrations(migrationPlan);
            if (summary.hasPending) {
                log.warn(
                    `Database schema is behind: ${summary.tablesToCreate} table(s) to create, ${summary.fieldsToAdd} field(s) to add. Applying migrations now.`,
                );
            }

            await runMigrations();
            await ensureRelaySessionTables();
            await ensurePushSubscriptionTable();
            await ensureUserHiddenModelTable();
            await ensureUserPreferenceTable();
            await ensureRunnerRecentFoldersTable();
            await ensureExtractedAttachmentTable();
            await ensureWebhookTable();
            await ensureEventTables();
            await ensureSetupClaimsTable();
            await ensureMobileLinkTable();
            await ensureNativePushRegistrationTable();
            await ensureRunnerOwnerTable();
            await migrateLegacyTriggerData();
            await backfillRouteOwners();
            log.info("All database migrations complete.");
        });
    } catch (e) {
        log.error("Migration failed:", e);
        process.exit(1);
    }
}

// ── Legacy trigger data → routes (ADR-0002 Phase 6, one-time) ────────────────

/**
 * Old-system params→filters conversion lives in events/engine.ts
 * (legacyParamsToFilters / legacyFiltersFromParams) — shared with the listener
 * API so new listeners follow the exact same rules as migrated ones.
 */

/**
 * One-time backfill: everything that used to live in the legacy subscription
 * and listener stores becomes a Route. Idempotent — rows whose id already
 * exists in trigger_route are skipped, so re-running is a no-op. Both legacy
 * tables are simply absent on fresh installs.
 *
 * - Session subscriptions become session-target routes, KEEPING their
 *   subscriptionId as the routeId so runner-side durable schedule state
 *   (keyed by subscription id) stays valid across the upgrade.
 * - Runner listeners become spawn routes (prompt → promptTemplate, listenerId
 *   → routeId). ownerUserId is deliberately unstamped: runner owners cannot be
 *   resolved at boot — spawning still works, and route management falls back
 *   to the durable runner-owner record (runner-owner.ts).
 *
 * Legacy params convert to filters (see legacyParamsToFilters) for every
 * non-schedule type; a repair pass also converts rows migrated by earlier
 * boots, before that conversion existed (identifiable by legacy id shapes).
 */
/** SQLite "no such table" — the legacy table is simply absent (fresh installs). */
function isMissingTableError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return message.includes("no such table");
}

export async function migrateLegacyTriggerData(): Promise<{ subs: number; listeners: number; invalid: number }> {
    const db = getKysely();
    let subs = 0;
    let listeners = 0;
    let invalid = 0;

    const existing = new Set((await listRoutes()).map((r) => r.routeId));

    type SubRow = { id: string; sessionId: string; runnerId: string; triggerType: string; subscriptionJson: string };
    // A missing legacy table is normal on fresh installs — skip. Any other
    // query failure must NOT be swallowed: an empty result would mark the
    // migration complete and silently deactivate every unmigrated schedule.
    const subRows = await db.selectFrom("trigger_subscription").selectAll().execute().catch((err) => {
        if (isMissingTableError(err)) return [] as SubRow[];
        log.error("Legacy subscription table query failed — aborting startup so it is not silently treated as migrated:", err);
        throw err;
    });
    for (const row of subRows) {
        if (existing.has(row.id)) {
            // Already migrated on an earlier boot — retire the legacy row
            // so user-deleted routes don't resurrect on the next restart.
            await db.deleteFrom("trigger_subscription").where("id", "=", row.id).execute().catch(() => {});
            continue;
        }
        let patch: { params?: Record<string, never>; filters?: unknown[]; filterMode?: "and" | "or" } = {};
        try {
            const parsed = JSON.parse(row.subscriptionJson) as Record<string, unknown>;
            if (parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params)) {
                patch.params = parsed.params as Record<string, never>;
            }
            if (Array.isArray(parsed.filters) && parsed.filters.length > 0) {
                patch.filters = parsed.filters;
                if (parsed.filterMode === "or") patch.filterMode = "or";
            } else {
                // No explicit filters: the old fire path matched params as filters.
                const converted = legacyFiltersFromParams(row.triggerType, patch.params as Record<string, unknown> | undefined);
                if (converted) patch.filters = converted as never;
            }
        } catch (err) {
            // Shape-only row — no params/filters to carry over, but the row's
            // columns still identify the subscription, so the route is created
            // (and only then is the row retired).
            invalid++;
            log.warn(`Legacy subscription row ${row.id}: unparseable subscriptionJson — migrating without params:`, err);
        }
        await createRoute(
            {
                eventType: row.triggerType,
                target: { kind: "session", sessionId: row.sessionId, runnerId: row.runnerId },
                // The legacy fire path delivered subscriber matches as
                // queued, non-interruptive deliveries — preserve that.
                deliverAs: "followUp",
                origin: "api",
                ...(patch.params ? { params: patch.params as Record<string, never> } : {}),
                ...(patch.filters ? { filters: patch.filters as never } : {}),
                ...(patch.filterMode ? { filterMode: patch.filterMode } : {}),
            },
            { routeId: row.id },
        );
        await db.deleteFrom("trigger_subscription").where("id", "=", row.id).execute().catch(() => {});
        subs++;
    }

    type ListenerRow = { id: string; runnerId: string; listenerJson: string };
    const listenerRows = await db.selectFrom("runner_trigger_listener").selectAll().execute().catch((err) => {
        if (isMissingTableError(err)) return [] as ListenerRow[];
        log.error("Legacy listener table query failed — aborting startup so it is not silently treated as migrated:", err);
        throw err;
    });
    for (const row of listenerRows) {
        if (existing.has(row.id)) {
            await db.deleteFrom("runner_trigger_listener").where("id", "=", row.id).execute().catch(() => {});
            continue;
        }
        let listener: { triggerType?: string; prompt?: string; cwd?: string; model?: { provider: string; id: string }; params?: Record<string, never>; autoClose?: boolean } = {};
        try {
            listener = JSON.parse(row.listenerJson) as typeof listener;
        } catch (err) {
            // Unparseable legacy row — leave it in place: a row is only
            // deleted after its route was successfully created, and this one
            // can never produce a route. It stays inspectable and retries on
            // every boot until fixed or removed by hand.
            invalid++;
            log.warn(`Legacy listener row ${row.id}: unparseable listenerJson — left in place:`, err);
            continue;
        }
        if (!listener.triggerType) {
            invalid++;
            log.warn(`Legacy listener row ${row.id}: missing triggerType — left in place`);
            continue;
        }
        const converted = legacyFiltersFromParams(listener.triggerType, listener.params);
        await createRoute(
            {
                eventType: listener.triggerType,
                target: {
                    kind: "spawn",
                    spec: {
                        runnerId: row.runnerId,
                        ...(listener.prompt ? { promptTemplate: listener.prompt } : {}),
                        ...(listener.cwd ? { cwd: listener.cwd } : {}),
                        ...(listener.model ? { model: listener.model } : {}),
                        ...(listener.autoClose ? { autoClose: true } : {}),
                    },
                },
                deliverAs: "followUp",
                ...(listener.params ? { params: listener.params as Record<string, never> } : {}),
                ...(converted ? { filters: converted as never } : {}),
                origin: "api",
            },
            { routeId: row.id },
        );
        await db.deleteFrom("runner_trigger_listener").where("id", "=", row.id).execute().catch(() => {});
        listeners++;
    }

    // Repair pass: rows already migrated to routes by an earlier boot,
    // before the params→filters conversion existed, still fire on every
    // event. Convert them once (skip rows with explicit filters — the old
    // fire path ignored params whenever filters were set, and skip
    // schedule types whose params are config, not filters). Marker: only
    // legacy-migrated ids match these shapes.
    let repairs = 0;
    for (const route of await listRoutes()) {
        const isLegacyId = route.routeId.startsWith("listener:") || route.routeId.startsWith("sub:") || route.routeId.startsWith("[");
        if (!isLegacyId || route.eventType.startsWith("time:")) continue;
        if (route.filters && route.filters.length > 0) continue;
        const converted = legacyFiltersFromParams(route.eventType, route.params as Record<string, unknown> | undefined);
        if (!converted) continue;
        try {
            await updateRoute(route.routeId, { filters: converted as never });
            repairs++;
        } catch (err) {
            log.warn(`Route ${route.routeId}: legacy params→filters repair failed:`, err);
        }
    }
    if (repairs > 0) log.info(`Converted legacy params to filters on ${repairs} migrated route(s).`);

    if (subs > 0 || listeners > 0 || invalid > 0) {
        log.info(`Migrated legacy trigger data: ${subs} subscription(s), ${listeners} listener(s) → routes, ${invalid} invalid row(s) left in place.`);
    }
    return { subs, listeners, invalid };
}

/**
 * Tenant-scope backfill: every non-config route needs an ownerUserId or it
 * matches nothing. Resolve from the durable records we have (spawn spec owner,
 * persisted session owner, runner owner). Idempotent — only ownerless rows.
 * Unresolvable rows stay ownerless: they never fire but remain deletable.
 */
export async function backfillRouteOwners(): Promise<{ stamped: number; unresolved: number }> {
    let stamped = 0;
    let unresolved = 0;
    let routes: Awaited<ReturnType<typeof listOwnerlessRoutes>> = [];
    try {
        routes = await listOwnerlessRoutes();
    } catch (err) {
        log.warn("route owner backfill: listing failed:", err);
        return { stamped, unresolved };
    }
    for (const route of routes) {
        try {
            let owner: string | null = null;
            if (route.target.kind === "spawn") {
                owner = route.target.spec.ownerUserId ?? (await getRunnerOwner(route.target.spec.runnerId));
            } else {
                const persisted = await getPersistedRelaySessionOwner(route.target.sessionId);
                owner = persisted?.userId
                    ?? (route.target.runnerId ? await getRunnerOwner(route.target.runnerId) : null)
                    ?? (persisted?.runnerId ? await getRunnerOwner(persisted.runnerId) : null);
            }
            if (owner) {
                await setRouteOwner(route.routeId, owner);
                stamped++;
            } else {
                unresolved++;
                log.warn(`route owner backfill: ${route.routeId} (${route.eventType}) has no resolvable owner — it will not match events until deleted/recreated`);
            }
        } catch (err) {
            unresolved++;
            log.warn(`route owner backfill: ${route.routeId} failed:`, err);
        }
    }
    if (stamped > 0 || unresolved > 0) {
        log.info(`route owner backfill: stamped ${stamped}, unresolved ${unresolved}`);
    }
    return { stamped, unresolved };
}
