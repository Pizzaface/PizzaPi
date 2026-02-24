import { kysely } from "./auth.js";

const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS ?? "30000");
const MAX_FAILURES = 3;
const PING_TIMEOUT_MS = 5000;

// In-memory consecutive failure counters keyed by instance ID
const failureCounts = new Map<string, number>();

let intervalHandle: ReturnType<typeof setInterval> | null = null;

async function pingInstance(host: string, port: number): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
        const res = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
        clearTimeout(timeout);
        return res.ok;
    } catch {
        return false;
    }
}

async function checkAll(): Promise<void> {
    const instances = await kysely
        .selectFrom("org_instances")
        .select(["id", "host", "port", "status"])
        .where("status", "!=", "stopped")
        .execute();

    const now = new Date().toISOString();

    for (const inst of instances) {
        if (!inst.host || !inst.port) continue;

        const ok = await pingInstance(inst.host, inst.port);

        if (ok) {
            failureCounts.delete(inst.id);
            await kysely
                .updateTable("org_instances")
                .set({ status: "healthy" as const, health_checked_at: now })
                .where("id", "=", inst.id)
                .execute();
        } else {
            const count = (failureCounts.get(inst.id) ?? 0) + 1;
            failureCounts.set(inst.id, count);

            const newStatus = count >= MAX_FAILURES ? "unhealthy" as const : inst.status;
            await kysely
                .updateTable("org_instances")
                .set({ status: newStatus, health_checked_at: now })
                .where("id", "=", inst.id)
                .execute();
        }
    }
}

export function startHealthCheckLoop(): void {
    if (intervalHandle) return;
    console.log(`[health] Starting health check loop (interval=${HEALTH_CHECK_INTERVAL}ms)`);
    // Run immediately, then on interval
    checkAll().catch((err) => console.error("[health] check error:", err));
    intervalHandle = setInterval(() => {
        checkAll().catch((err) => console.error("[health] check error:", err));
    }, HEALTH_CHECK_INTERVAL);
}

export function stopHealthCheckLoop(): void {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
}
