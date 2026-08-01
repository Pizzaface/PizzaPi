import { describe, test, expect, mock } from "bun:test";
import type { PizzaPiSocket, ServiceHandler } from "@pizzapi/extension-sdk";
import { removeVanishedLegacyServices, type PanelEntry } from "./daemon.js";
import { ServiceRegistry } from "./service-handler.js";
import { TunnelService } from "./services/tunnel-service.js";

/**
 * Lifecycle-level coverage for reconfigure_services against a *live*
 * ServiceRegistry — the disabled-set parsing tests in daemon-services.test.ts
 * never caught that a deleted plugin's handler stayed registered and running.
 */

function createMockSocket() {
    const listeners = new Map<string, Function[]>();
    return {
        emitted: [] as Array<[string, ...unknown[]]>,
        listeners,
        emit: mock(function (this: any, ...args: unknown[]) {
            this.emitted.push(args as [string, ...unknown[]]);
        }),
        on: mock((event: string, handler: Function) => {
            listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        }),
        off: mock((event: string, handler: Function) => {
            listeners.set(event, (listeners.get(event) ?? []).filter((fn) => fn !== handler));
        }),
    };
}

/** A service that records whether it was disposed, like a real plugin handler. */
function createFakeService(id: string) {
    const state = { disposed: 0, initialized: 0 };
    const handler: ServiceHandler = {
        id,
        init(_socket: PizzaPiSocket) {
            state.initialized += 1;
        },
        dispose() {
            state.disposed += 1;
        },
    };
    return { handler, state };
}

interface Harness {
    registry: ServiceRegistry;
    tunnel: TunnelService;
    tunnelClient: { exposePort: ReturnType<typeof mock>; unexposePort: ReturnType<typeof mock> };
    tracked: Set<string>;
    legacyServiceIds: Set<string>;
    initializedServiceIds: Set<string>;
    panelEntries: Map<string, PanelEntry>;
    sigilServerPorts: Map<string, number>;
    disposeIncumbent: (id: string, reason: string) => void;
    releasePort: (port: number) => void;
}

/** Wire the same collaborators the daemon composes around the removal loop. */
function createHarness(): Harness {
    const registry = new ServiceRegistry();
    const tunnel = new TunnelService();
    const tunnelClient = { exposePort: mock((_p: number) => {}), unexposePort: mock((_p: number) => {}) };
    const socket = createMockSocket();
    tunnel.setTunnelClient(tunnelClient as any);
    tunnel.init(socket as any, { isShuttingDown: () => false });

    const initializedServiceIds = new Set<string>();
    const disposeIncumbent = (id: string, _reason: string) => {
        const svc = registry.get(id);
        if (!svc) return;
        svc.dispose();
        registry.unregister(id);
        initializedServiceIds.delete(id);
    };

    return {
        registry,
        tunnel,
        tunnelClient,
        tracked: new Set<string>(),
        legacyServiceIds: new Set<string>(),
        initializedServiceIds,
        panelEntries: new Map<string, PanelEntry>(),
        sigilServerPorts: new Map<string, number>(),
        disposeIncumbent,
        releasePort: (port: number) => { tunnel.unregisterPort(port); },
    };
}

/** Register a legacy service the way the daemon does when it discovers a plugin. */
function mountLegacyService(h: Harness, id: string, opts: { panelPort?: number; sigilPort?: number } = {}) {
    const svc = createFakeService(id);
    h.registry.register(svc.handler);
    h.initializedServiceIds.add(id);
    h.tracked.add(id);
    h.legacyServiceIds.add(id);
    h.panelEntries.set(id, {
        serviceId: id,
        label: id,
        icon: "square",
        ...(opts.panelPort !== undefined ? { port: opts.panelPort } : {}),
    });
    if (opts.panelPort !== undefined) h.tunnel.registerPort(opts.panelPort, id);
    if (opts.sigilPort !== undefined) {
        h.sigilServerPorts.set(id, opts.sigilPort);
        h.tunnel.registerPort(opts.sigilPort, id);
    }
    return svc;
}

function removeVanished(h: Harness, stillDiscovered: string[], disabled: string[] = [], packageIds: string[] = []) {
    return removeVanishedLegacyServices({
        tracked: h.tracked,
        legacyServiceIds: h.legacyServiceIds,
        packageServiceIds: new Set(packageIds),
        disabledIds: new Set(disabled),
        stillDiscovered: new Set(stillDiscovered),
        panelEntries: h.panelEntries,
        sigilServerPorts: h.sigilServerPorts,
        disposeIncumbent: h.disposeIncumbent,
        releasePort: h.releasePort,
    });
}

describe("removeVanishedLegacyServices (live registry lifecycle)", () => {
    test("a deleted plugin's service is disposed and unregistered, not just forgotten", () => {
        const h = createHarness();
        const svc = mountLegacyService(h, "gone");

        expect(removeVanished(h, [])).toEqual(["gone"]);

        expect(svc.state.disposed).toBe(1);
        expect(h.registry.has("gone")).toBe(false);
        expect(h.initializedServiceIds.has("gone")).toBe(false);
        expect(h.tracked.has("gone")).toBe(false);
        expect(h.legacyServiceIds.has("gone")).toBe(false);
    });

    test("a deleted plugin's panel and sigil ports stop being routed", () => {
        const h = createHarness();
        mountLegacyService(h, "gone", { panelPort: 4321, sigilPort: 8765 });

        removeVanished(h, []);

        expect(h.tunnelClient.unexposePort).toHaveBeenCalledWith(4321);
        expect(h.tunnelClient.unexposePort).toHaveBeenCalledWith(8765);
        expect(h.panelEntries.has("gone")).toBe(false);
        expect(h.sigilServerPorts.has("gone")).toBe(false);
    });

    test("a still-discoverable service keeps running and keeps its port", () => {
        const h = createHarness();
        const svc = mountLegacyService(h, "kept", { panelPort: 4321 });

        expect(removeVanished(h, ["kept"])).toEqual([]);

        expect(svc.state.disposed).toBe(0);
        expect(h.registry.has("kept")).toBe(true);
        expect(h.tunnelClient.unexposePort).not.toHaveBeenCalled();
    });

    test("a disabled service is left intact so it can be re-enabled", () => {
        const h = createHarness();
        const svc = mountLegacyService(h, "off");

        expect(removeVanished(h, [], ["off"])).toEqual([]);

        expect(svc.state.disposed).toBe(0);
        expect(h.tracked.has("off")).toBe(true);
    });

    test("a package-origin id is left to the package reconciler", () => {
        const h = createHarness();
        const svc = mountLegacyService(h, "pkg");

        expect(removeVanished(h, [], [], ["pkg"])).toEqual([]);

        expect(svc.state.disposed).toBe(0);
        expect(h.registry.has("pkg")).toBe(true);
    });

    test("removing one vanished service does not disturb its neighbours", () => {
        const h = createHarness();
        const gone = mountLegacyService(h, "gone", { panelPort: 4321 });
        const kept = mountLegacyService(h, "kept", { panelPort: 5555 });

        expect(removeVanished(h, ["kept"])).toEqual(["gone"]);

        expect(gone.state.disposed).toBe(1);
        expect(kept.state.disposed).toBe(0);
        expect(h.registry.has("kept")).toBe(true);
        expect(h.tunnelClient.unexposePort).toHaveBeenCalledWith(4321);
        expect(h.tunnelClient.unexposePort).not.toHaveBeenCalledWith(5555);
    });

    test("a vanished service that never announced a port is still retired cleanly", () => {
        const h = createHarness();
        const svc = mountLegacyService(h, "portless");

        expect(removeVanished(h, [])).toEqual(["portless"]);

        expect(svc.state.disposed).toBe(1);
        expect(h.tunnelClient.unexposePort).not.toHaveBeenCalled();
    });

    test("removal is idempotent across repeated reconfigure passes", () => {
        const h = createHarness();
        mountLegacyService(h, "gone", { panelPort: 4321 });

        expect(removeVanished(h, [])).toEqual(["gone"]);
        expect(removeVanished(h, [])).toEqual([]);
        expect(h.tunnelClient.unexposePort).toHaveBeenCalledTimes(1);
    });

    test("a throwing dispose does not strand the rest of the removal", () => {
        const h = createHarness();
        const exploding: ServiceHandler = {
            id: "boom",
            init() {},
            dispose() { throw new Error("dispose failed"); },
        };
        h.registry.register(exploding);
        h.tracked.add("boom");
        h.legacyServiceIds.add("boom");

        // The daemon's disposeIncumbent swallows dispose errors; assert the
        // registry still sheds the handler rather than keeping a dead one.
        const guarded = { ...h, disposeIncumbent: (id: string) => {
            const svc = h.registry.get(id);
            if (!svc) return;
            try { svc.dispose(); } catch { /* daemon logs and continues */ }
            h.registry.unregister(id);
        } };

        expect(removeVanished(guarded as Harness, [])).toEqual(["boom"]);
        expect(h.registry.has("boom")).toBe(false);
    });
});
