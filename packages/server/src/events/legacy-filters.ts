/**
 * Legacy params → filter conversion (ADR-0002).
 *
 * Old-system semantics: subscription/listener "params" doubled as delivery
 * filters — every key matched against the event payload (equality, arrays as
 * OR sets) and a `*Contains` suffix meant substring matching. The unified
 * engine only matches `filters`, so params stored as-is fire a route on every
 * payload of its type. Convert them, keeping params too (subscription
 * snapshots still read them).
 *
 * Pure module (no imports): shared by the legacy migration (migrations.ts)
 * and the listener API (routes/runners.ts) so new listeners follow the exact
 * same rules as migrated ones.
 */

export function legacyParamsToFilters(params: Record<string, unknown>): Array<{ field: string; value: unknown; op: "eq" | "contains" }> {
    const filters: Array<{ field: string; value: unknown; op: "eq" | "contains" }> = [];
    for (const [key, expected] of Object.entries(params)) {
        const lower = key.toLowerCase();
        const isContains = lower.endsWith("contains") && key.length > "contains".length;
        const field = isContains ? key.slice(0, -"contains".length) : key;
        filters.push({ field, value: expected, op: isContains ? "contains" : "eq" });
    }
    return filters;
}

/** Params on time:* routes are schedule config (cron expression etc.), never filters. */
export function legacyFiltersFromParams(eventType: string, params: Record<string, unknown> | undefined): Array<{ field: string; value: unknown; op: "eq" | "contains" }> | undefined {
    if (eventType.startsWith("time:") || !params || Object.keys(params).length === 0) return undefined;
    const filters = legacyParamsToFilters(params);
    return filters.length > 0 ? filters : undefined;
}