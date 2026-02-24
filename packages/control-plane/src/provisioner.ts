import Docker from "dockerode";
import { kysely } from "./auth.js";
import { registerUpstream, deregisterUpstream } from "./caddy.js";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const SERVER_IMAGE = process.env.PIZZAPI_SERVER_IMAGE ?? "pizzapi/server:latest";
const DOCKER_NETWORK = process.env.PIZZAPI_DOCKER_NETWORK ?? "pizzapi-net";
const PORT_RANGE_START = parseInt(process.env.PIZZAPI_PORT_START ?? "4000");
const PORT_RANGE_END = parseInt(process.env.PIZZAPI_PORT_END ?? "4999");
const CP_BASE_URL = process.env.CP_BASE_URL ?? `http://localhost:${process.env.PORT ?? "3100"}`;

async function allocatePort(): Promise<number> {
    const usedPorts = await kysely
        .selectFrom("org_instances")
        .select("port")
        .where("status", "!=", "stopped")
        .where("port", "is not", null)
        .execute();

    const used = new Set(usedPorts.map((r) => r.port));
    for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
        if (!used.has(p)) return p;
    }
    throw new Error("No available ports in range");
}

async function ensureNetwork(): Promise<void> {
    try {
        const net = docker.getNetwork(DOCKER_NETWORK);
        await net.inspect();
    } catch {
        await docker.createNetwork({ Name: DOCKER_NETWORK, Driver: "bridge" });
    }
}

export async function provisionInstance(orgId: string, orgSlug: string): Promise<void> {
    const instanceId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Insert provisioning record
    await kysely
        .insertInto("org_instances")
        .values({ id: instanceId, org_id: orgId, status: "provisioning", created_at: now })
        .execute();

    try {
        await ensureNetwork();
        const port = await allocatePort();
        const containerName = `pizzapi-org-${orgSlug}`;

        const container = await docker.createContainer({
            Image: SERVER_IMAGE,
            name: containerName,
            Env: [
                `ORG_ID=${orgId}`,
                `ORG_SLUG=${orgSlug}`,
                `REDIS_PREFIX=org:${orgSlug}:`,
                `JWT_JWKS_URL=${CP_BASE_URL}/.well-known/jwks.json`,
                `PORT=${port}`,
            ],
            Labels: {
                "pizzapi.org": orgSlug,
                "pizzapi.type": "org-instance",
            },
            HostConfig: {
                PortBindings: {
                    [`${port}/tcp`]: [{ HostPort: String(port) }],
                },
                RestartPolicy: { Name: "unless-stopped" },
                NetworkMode: DOCKER_NETWORK,
            },
            ExposedPorts: {
                [`${port}/tcp`]: {},
            },
        });

        await container.start();
        const info = await container.inspect();

        await kysely
            .updateTable("org_instances")
            .set({
                container_id: info.Id,
                host: containerName,
                port,
                status: "healthy",
            })
            .where("id", "=", instanceId)
            .execute();

        // Register upstream with Caddy reverse proxy
        try {
            await registerUpstream(orgSlug, containerName, port);
        } catch (err) {
            console.error(`[provisioner] Caddy upstream registration failed for ${orgSlug}:`, err);
            // Non-fatal: container is running, Caddy can be retried
        }

        await kysely
            .updateTable("organizations")
            .set({ status: "active", updated_at: new Date().toISOString() })
            .where("id", "=", orgId)
            .execute();
    } catch (err) {
        console.error(`[provisioner] Failed to provision org ${orgSlug}:`, err);

        await kysely
            .updateTable("org_instances")
            .set({ status: "stopped" as const })
            .where("id", "=", instanceId)
            .execute();

        await kysely
            .updateTable("organizations")
            .set({ status: "suspended" as const, updated_at: new Date().toISOString() })
            .where("id", "=", orgId)
            .execute();

        throw err;
    }
}

export async function deprovisionInstance(orgId: string, orgSlug: string): Promise<void> {
    const instance = await kysely
        .selectFrom("org_instances")
        .select(["id", "container_id"])
        .where("org_id", "=", orgId)
        .where("status", "!=", "stopped")
        .executeTakeFirst();

    // Deregister upstream from Caddy first
    try {
        await deregisterUpstream(orgSlug);
    } catch (err) {
        console.error(`[provisioner] Caddy upstream deregistration failed for ${orgSlug}:`, err);
    }

    if (instance?.container_id) {
        try {
            const container = docker.getContainer(instance.container_id);
            try { await container.stop({ t: 10 }); } catch { /* already stopped */ }
            try { await container.remove({ force: true }); } catch { /* already removed */ }
        } catch (err) {
            console.error(`[provisioner] Error removing container for org ${orgSlug}:`, err);
        }
    }

    if (instance) {
        await kysely
            .updateTable("org_instances")
            .set({ status: "stopped" as const })
            .where("id", "=", instance.id)
            .execute();
    }
}
