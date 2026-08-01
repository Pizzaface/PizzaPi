/**
 * Integration coverage for a PACKAGE-ORIGIN runner service flowing through
 * the wire-compatible service_announce pipeline (Godmother nIMOA8cm).
 *
 * The wire protocol (service_announce / ServiceAnnounceData) has no origin
 * discriminator — a package-origin service (declared via a package's
 * pi.pizzapi overlay manifest, see packages/cli/src/runner/package-service-loader.ts)
 * must flow through announce -> Redis persistence -> viewer hydration exactly
 * like any folder-based or plugin-manifest service. These tests use the mock
 * runner harness to announce a realistic package-style service (panel +
 * trigger + sigil) and verify the relay/server treat it identically.
 *
 * Each test creates and cleans up its OWN server (module-level singletons
 * require sequential server creation — see mock-runner.test.ts).
 */
import { describe, test, expect } from "bun:test";
import type { ServicePanelInfo, ServiceTriggerDef, ServiceSigilDef, ServiceAnnounceData, ServiceAnnounceDelta } from "@pizzapi/protocol";
import { createTestServer } from "./server.js";
import { TestScenario } from "./scenario.js";
import type { TestServer } from "./types.js";

const TEST_TIMEOUT = 30_000;

async function cleanupServer(server: TestServer): Promise<void> {
    await server.io.disconnectSockets(true);
    await new Promise<void>((r) => setTimeout(r, 100));
    const httpServer = (server.io as unknown as { httpServer?: { closeIdleConnections?(): void } }).httpServer;
    if (typeof httpServer?.closeIdleConnections === "function") {
        httpServer.closeIdleConnections();
    }
    await server.cleanup();
}

// A realistic package-origin service manifest, mirroring what
// discoverPackageServices() would hand the daemon: a panel, a namespaced
// trigger, and a sigil type — the exact shape package-service-loader.ts
// builds from a pi.pizzapi overlay's `services[]` declaration.
const PACKAGE_SERVICE_ID = "godmother-lite";
const PACKAGE_PANEL: ServicePanelInfo = {
    serviceId: PACKAGE_SERVICE_ID,
    port: 34567,
    label: "Godmother Lite",
    icon: "sparkles",
};
const PACKAGE_TRIGGER: ServiceTriggerDef = {
    type: "godmother-lite:idea_moved",
    label: "Idea Status Changed",
    description: "Fires when an idea's status changes",
    schema: { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } },
    params: [{ name: "project", label: "Project", type: "string", required: false }],
};
const PACKAGE_SIGIL: ServiceSigilDef = {
    type: "gm-idea",
    label: "Godmother Idea",
    serviceId: PACKAGE_SERVICE_ID,
    description: "Reference to a Godmother idea",
    icon: "lightbulb",
    resolve: "/api/resolve/gm-idea/{id}",
};

describe("package-origin service_announce integration", () => {
    test(
        "panel + trigger + sigil defs reach a connected viewer verbatim, with no origin field",
        async () => {
            const server = await createTestServer();
            const scenario = new TestScenario();
            scenario.setServer(server);
            try {
                const runner = await scenario.addRunner({
                    serviceIds: ["terminal", "file-explorer", "git", "tunnel", PACKAGE_SERVICE_ID],
                    panels: [PACKAGE_PANEL],
                    triggerDefs: [PACKAGE_TRIGGER],
                    sigilDefs: [PACKAGE_SIGIL],
                });
                const session = await scenario.addSession({ cwd: "/tmp/test" });
                runner.emitSessionReady(session.sessionId);

                const viewer = await scenario.addViewer(session.sessionId);
                const announce = await new Promise<ServiceAnnounceData>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error("timed out waiting for service_announce")), 8000);
                    viewer.socket.on("service_announce", (data) => {
                        const d = data as ServiceAnnounceData;
                        if (d.serviceIds.includes(PACKAGE_SERVICE_ID)) {
                            clearTimeout(timer);
                            resolve(d);
                        }
                    });
                });

                expect(announce.serviceIds).toContain(PACKAGE_SERVICE_ID);
                expect(announce.panels).toContainEqual(PACKAGE_PANEL);
                expect(announce.triggerDefs).toContainEqual(PACKAGE_TRIGGER);
                expect(announce.sigilDefs).toContainEqual(PACKAGE_SIGIL);
                // The wire payload never carries an origin/provenance discriminator —
                // package-origin services are indistinguishable from any other source.
                expect(announce).not.toHaveProperty("origin");
                expect(announce).not.toHaveProperty("source");
                for (const panel of announce.panels ?? []) expect(panel).not.toHaveProperty("origin");
                for (const t of announce.triggerDefs ?? []) expect(t).not.toHaveProperty("origin");
                for (const s of announce.sigilDefs ?? []) expect(s).not.toHaveProperty("origin");
            } finally {
                await scenario.teardown();
                await cleanupServer(server);
            }
        },
        TEST_TIMEOUT,
    );

    test(
        "panel/trigger/sigil metadata is persisted to Redis and served via GET /api/runners/:id/services",
        async () => {
            const server = await createTestServer();
            const scenario = new TestScenario();
            scenario.setServer(server);
            try {
                const runner = await scenario.addRunner({
                    serviceIds: ["terminal", PACKAGE_SERVICE_ID],
                    panels: [PACKAGE_PANEL],
                    triggerDefs: [PACKAGE_TRIGGER],
                    sigilDefs: [PACKAGE_SIGIL],
                });
                const session = await scenario.addSession({ cwd: "/tmp/test" });
                runner.emitSessionReady(session.sessionId);
                // Attach a viewer solely to know the announce has round-tripped
                // through the server (and therefore been persisted) before we GET.
                const viewer = await scenario.addViewer(session.sessionId);
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error("timed out waiting for service_announce")), 8000);
                    viewer.socket.on("service_announce", (data) => {
                        if ((data as ServiceAnnounceData).serviceIds.includes(PACKAGE_SERVICE_ID)) {
                            clearTimeout(timer);
                            resolve();
                        }
                    });
                });

                const res = await server.fetch(`/api/runners/${encodeURIComponent(runner.runnerId)}/services`);
                expect(res.status).toBe(200);
                const body = await res.json() as ServiceAnnounceData;
                expect(body.serviceIds).toContain(PACKAGE_SERVICE_ID);
                expect(body.panels).toContainEqual(PACKAGE_PANEL);
                expect(body.triggerDefs).toContainEqual(PACKAGE_TRIGGER);
                expect(body.sigilDefs).toContainEqual(PACKAGE_SIGIL);
            } finally {
                await scenario.teardown();
                await cleanupServer(server);
            }
        },
        TEST_TIMEOUT,
    );

    test(
        "a fresh viewer connection (reload/reconnect) hydrates panel/trigger/sigil defs from the server cache without a new runner announce",
        async () => {
            const server = await createTestServer();
            const scenario = new TestScenario();
            scenario.setServer(server);
            try {
                const runner = await scenario.addRunner({
                    serviceIds: ["terminal", PACKAGE_SERVICE_ID],
                    panels: [PACKAGE_PANEL],
                    triggerDefs: [PACKAGE_TRIGGER],
                    sigilDefs: [PACKAGE_SIGIL],
                });
                const session = await scenario.addSession({ cwd: "/tmp/test" });
                runner.emitSessionReady(session.sessionId);

                const firstViewer = await scenario.addViewer(session.sessionId);
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error("timed out waiting for first announce")), 8000);
                    firstViewer.socket.on("service_announce", (data) => {
                        if ((data as ServiceAnnounceData).serviceIds.includes(PACKAGE_SERVICE_ID)) {
                            clearTimeout(timer);
                            resolve();
                        }
                    });
                });
                // Simulate a viewer reload: disconnect entirely, then reconnect a
                // brand-new socket to the same session. No new runner announce
                // is sent — this must hydrate purely from server-side state
                // (the connect-time "cache-first hydration" path in viewer.ts).
                await firstViewer.disconnect();

                const secondViewer = await scenario.addViewer(session.sessionId);
                const rehydrated = await new Promise<ServiceAnnounceData>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error("timed out waiting for rehydrated announce")), 8000);
                    secondViewer.socket.on("service_announce", (data) => {
                        const d = data as ServiceAnnounceData;
                        if (d.serviceIds.includes(PACKAGE_SERVICE_ID)) {
                            clearTimeout(timer);
                            resolve(d);
                        }
                    });
                });

                expect(rehydrated.panels).toContainEqual(PACKAGE_PANEL);
                expect(rehydrated.triggerDefs).toContainEqual(PACKAGE_TRIGGER);
                expect(rehydrated.sigilDefs).toContainEqual(PACKAGE_SIGIL);
            } finally {
                await scenario.teardown();
                await cleanupServer(server);
            }
        },
        TEST_TIMEOUT,
    );

    test(
        "disabling the package service via the reconfigure route round-trips through the runner and persists",
        async () => {
            const server = await createTestServer();
            const scenario = new TestScenario();
            scenario.setServer(server);
            try {
                const runner = await scenario.addRunner({
                    serviceIds: ["terminal", PACKAGE_SERVICE_ID],
                    panels: [PACKAGE_PANEL],
                    triggerDefs: [PACKAGE_TRIGGER],
                    sigilDefs: [PACKAGE_SIGIL],
                });
                const session = await scenario.addSession({ cwd: "/tmp/test" });
                runner.emitSessionReady(session.sessionId);

                const viewer = await scenario.addViewer(session.sessionId);
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error("timed out waiting for initial announce")), 8000);
                    viewer.socket.on("service_announce", (data) => {
                        if ((data as ServiceAnnounceData).serviceIds.includes(PACKAGE_SERVICE_ID)) {
                            clearTimeout(timer);
                            resolve();
                        }
                    });
                });

                // The daemon removes disabled non-built-ins and their metadata
                // from service_announce, retaining only disabledServiceIds.
                const disabledAnnounce = new Promise<ServiceAnnounceData>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error("timed out waiting for disabled re-announce")), 8000);
                    viewer.socket.on("service_announce", (data) => {
                        const d = data as ServiceAnnounceData;
                        if (d.disabledServiceIds?.includes(PACKAGE_SERVICE_ID)) {
                            clearTimeout(timer);
                            resolve(d);
                        }
                    });
                });

                const putRes = await server.fetch(
                    `/api/runners/${encodeURIComponent(runner.runnerId)}/services/${encodeURIComponent(PACKAGE_SERVICE_ID)}/enabled`,
                    {
                        method: "PUT",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ enabled: false }),
                    },
                );
                expect(putRes.status).toBe(200);

                const disabled = await disabledAnnounce;
                expect(disabled.disabledServiceIds).toContain(PACKAGE_SERVICE_ID);
                expect(disabled.serviceIds).not.toContain(PACKAGE_SERVICE_ID);
                expect(disabled.panels).not.toContainEqual(PACKAGE_PANEL);
                expect(disabled.triggerDefs).not.toContainEqual(PACKAGE_TRIGGER);
                expect(disabled.sigilDefs).not.toContainEqual(PACKAGE_SIGIL);

                // Persisted state (what a reload would GET) matches the daemon too.
                const res = await server.fetch(`/api/runners/${encodeURIComponent(runner.runnerId)}/services`);
                const body = await res.json() as ServiceAnnounceData;
                expect(body.disabledServiceIds).toContain(PACKAGE_SERVICE_ID);
                expect(body.serviceIds).not.toContain(PACKAGE_SERVICE_ID);
                expect(body.panels).not.toContainEqual(PACKAGE_PANEL);
                expect(body.triggerDefs).not.toContainEqual(PACKAGE_TRIGGER);
                expect(body.sigilDefs).not.toContainEqual(PACKAGE_SIGIL);

                const enabledAnnounce = new Promise<ServiceAnnounceDelta>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error("timed out waiting for enabled re-announce")), 8000);
                    viewer.socket.on("service_announce_delta", (data) => {
                        const d = data as ServiceAnnounceDelta;
                        if (d.added.serviceIds.includes(PACKAGE_SERVICE_ID)) {
                            clearTimeout(timer);
                            resolve(d);
                        }
                    });
                });
                const reenableRes = await server.fetch(
                    `/api/runners/${encodeURIComponent(runner.runnerId)}/services/${encodeURIComponent(PACKAGE_SERVICE_ID)}/enabled`,
                    {
                        method: "PUT",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ enabled: true }),
                    },
                );
                expect(reenableRes.status).toBe(200);

                const enabled = await enabledAnnounce;
                expect(enabled.added.panels).toContainEqual(PACKAGE_PANEL);
                expect(enabled.added.triggerDefs).toContainEqual(PACKAGE_TRIGGER);
                expect(enabled.added.sigilDefs).toContainEqual(PACKAGE_SIGIL);
            } finally {
                await scenario.teardown();
                await cleanupServer(server);
            }
        },
        TEST_TIMEOUT,
    );

    test(
        "subscribing to the package trigger creates a listener visible via GET /api/runners/:id/triggers",
        async () => {
            const server = await createTestServer();
            const scenario = new TestScenario();
            scenario.setServer(server);
            try {
                const runner = await scenario.addRunner({
                    serviceIds: ["terminal", PACKAGE_SERVICE_ID],
                    panels: [PACKAGE_PANEL],
                    triggerDefs: [PACKAGE_TRIGGER],
                    sigilDefs: [PACKAGE_SIGIL],
                });
                const session = await scenario.addSession({ cwd: "/tmp/test" });
                runner.emitSessionReady(session.sessionId);

                const viewer = await scenario.addViewer(session.sessionId);
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error("timed out waiting for announce")), 8000);
                    viewer.socket.on("service_announce", (data) => {
                        if ((data as ServiceAnnounceData).serviceIds.includes(PACKAGE_SERVICE_ID)) {
                            clearTimeout(timer);
                            resolve();
                        }
                    });
                });

                const subRes = await server.fetch(
                    `/api/runners/${encodeURIComponent(runner.runnerId)}/trigger-listeners`,
                    {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                            triggerType: PACKAGE_TRIGGER.type,
                            params: { project: "PizzaPi" },
                            prompt: "Summarize the moved idea",
                        }),
                    },
                );
                expect(subRes.status).toBe(200);
                const subBody = await subRes.json() as { listenerId?: string };
                expect(subBody.listenerId).toBeTruthy();

                const triggersRes = await server.fetch(`/api/runners/${encodeURIComponent(runner.runnerId)}/triggers`);
                expect(triggersRes.status).toBe(200);
                const triggersBody = await triggersRes.json() as { triggerDefs: ServiceTriggerDef[]; listeners: Array<{ triggerType: string; listenerId?: string }> };
                expect(triggersBody.triggerDefs).toContainEqual(PACKAGE_TRIGGER);
                expect(triggersBody.listeners.some((l) => l.triggerType === PACKAGE_TRIGGER.type)).toBe(true);
            } finally {
                await scenario.teardown();
                await cleanupServer(server);
            }
        },
        TEST_TIMEOUT,
    );
});
