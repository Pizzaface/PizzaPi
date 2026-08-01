import { describe, expect, test } from "bun:test";
import {
    canRegisterDiscoveredService,
    clearServiceRuntimePorts,
    panelEntryFromManifest,
    planPackageServiceReconcile,
    raceWithTimeout,
    timedOutPackageDiscoveryResult,
    PACKAGE_DISCOVERY_TIMEOUT_MS,
    type PanelEntry,
} from "./daemon.js";
import { ServiceRegistry } from "./service-handler.js";
import { BUILTIN_SERVICE_IDS, NON_DISABLEABLE_SERVICE_IDS } from "./services/builtin-service-ids.js";
import type { ServiceHandler } from "./service-handler.js";
import type { ServiceManifest } from "./service-loader.js";

function makeHandler(id: string): ServiceHandler {
    return { id, init() {}, dispose() {} };
}

describe("canRegisterDiscoveredService — package-before-legacy ordering (§8)", () => {
    test("first caller for an id wins; a second caller for the same id is rejected as a collision", () => {
        const registry = new ServiceRegistry();
        const packageHandler = makeHandler("shared");
        const legacyHandler = makeHandler("shared");

        // Mirrors daemon.ts: package discovery is awaited + registered
        // before legacy discovery, so it reaches this guard first.
        const packageDecision = canRegisterDiscoveredService(BUILTIN_SERVICE_IDS.has("shared"), registry.has("shared"));
        expect(packageDecision).toEqual({ register: true });
        registry.register(packageHandler);

        // Legacy discovery runs second — same id, now collides.
        const legacyDecision = canRegisterDiscoveredService(BUILTIN_SERVICE_IDS.has("shared"), registry.has("shared"));
        expect(legacyDecision).toEqual({ register: false, reason: "collision" });
        expect(registry.get("shared")).toBe(packageHandler);
        expect(registry.get("shared")).not.toBe(legacyHandler);
    });

    test("built-ins are rejected before the collision check even runs, regardless of order", () => {
        const registry = new ServiceRegistry();
        const decision = canRegisterDiscoveredService(BUILTIN_SERVICE_IDS.has("terminal"), registry.has("terminal"));
        expect(decision).toEqual({ register: false, reason: "builtin" });
    });
});

describe("NON_DISABLEABLE_SERVICE_IDS vs BUILTIN_SERVICE_IDS (addendum A)", () => {
    test("memory and process are collision-reserved but NOT in the runtime non-disableable set", () => {
        expect(BUILTIN_SERVICE_IDS.has("memory")).toBe(true);
        expect(BUILTIN_SERVICE_IDS.has("process")).toBe(true);
        expect(NON_DISABLEABLE_SERVICE_IDS.has("memory")).toBe(false);
        expect(NON_DISABLEABLE_SERVICE_IDS.has("process")).toBe(false);
    });

    test("the original five (terminal/file-explorer/git/time/tunnel) stay non-disableable", () => {
        expect([...NON_DISABLEABLE_SERVICE_IDS].sort()).toEqual(
            ["file-explorer", "git", "terminal", "time", "tunnel"],
        );
    });
});

describe("panelEntryFromManifest (fix #3: hasPanel routing)", () => {
    test("a service with a panel gets hasPanel: true", () => {
        const manifest: ServiceManifest = { id: "svc", label: "Svc", icon: "square", panel: { dir: "/abs/panel" } };
        const entry = panelEntryFromManifest("svc", manifest);
        expect(entry?.hasPanel).toBe(true);
    });

    test("a service with only triggers/sigils and no panel gets hasPanel: false", () => {
        const manifest: ServiceManifest = {
            id: "svc",
            label: "Svc",
            icon: "square",
            hasPanel: false,
            triggers: [{ type: "svc:event", label: "Event" }],
        };
        const entry = panelEntryFromManifest("svc", manifest);
        expect(entry?.hasPanel).toBe(false);
        expect(entry?.triggers).toHaveLength(1);
    });

    test("legacy manifests without an explicit hasPanel infer it from panel presence", () => {
        const withPanel: ServiceManifest = { id: "svc", label: "Svc", icon: "square", panel: { dir: "/x" } };
        const withoutPanel: ServiceManifest = { id: "svc", label: "Svc", icon: "square", sigils: [{ type: "x", label: "X" }] };
        expect(panelEntryFromManifest("svc", withPanel)?.hasPanel).toBe(true);
        expect(panelEntryFromManifest("svc", withoutPanel)?.hasPanel).toBe(false);
    });

    test("no panel/triggers/sigils at all yields null (nothing to track)", () => {
        const manifest: ServiceManifest = { id: "svc", label: "Svc", icon: "square" };
        expect(panelEntryFromManifest("svc", manifest)).toBeNull();
        expect(panelEntryFromManifest("svc", undefined)).toBeNull();
    });

    test("preserves an already-announced port across a metadata refresh", () => {
        const manifest: ServiceManifest = { id: "svc", label: "New Label", icon: "square", panel: { dir: "/x" } };
        const entry = panelEntryFromManifest("svc", manifest, 4321);
        expect(entry?.port).toBe(4321);
        expect(entry?.label).toBe("New Label");
    });
});

describe("clearServiceRuntimePorts (final-review port hygiene)", () => {
    test("identity swap or legacy eviction removes all stale runtime metadata", () => {
        const panels = new Map<string, PanelEntry>([["svc", { serviceId: "svc", label: "Old", icon: "square", port: 4321 }]]);
        const sigilPorts = new Map([["svc", 8765]]);

        clearServiceRuntimePorts("svc", panels, sigilPorts, false);

        expect(panels.has("svc")).toBe(false);
        expect(sigilPorts.has("svc")).toBe(false);
    });

    test("disable keeps metadata visible but strips panel and sigil-server ports", () => {
        const panels = new Map<string, PanelEntry>([["svc", { serviceId: "svc", label: "Svc", icon: "square", port: 4321 }]]);
        const sigilPorts = new Map([["svc", 8765]]);

        clearServiceRuntimePorts("svc", panels, sigilPorts, true);

        expect(panels.get("svc")).toEqual({ serviceId: "svc", label: "Svc", icon: "square" });
        expect(sigilPorts.has("svc")).toBe(false);
    });

    test("releases both the panel port and the sigil-server port back to the tunnel", () => {
        // Forgetting the port only stops it being announced; the runner keeps
        // proxying to it unless it is handed back to the tunnel.
        const panels = new Map<string, PanelEntry>([["svc", { serviceId: "svc", label: "Svc", icon: "square", port: 4321 }]]);
        const sigilPorts = new Map([["svc", 8765]]);
        const released: number[] = [];

        clearServiceRuntimePorts("svc", panels, sigilPorts, false, (port) => released.push(port));

        expect(released.sort()).toEqual([4321, 8765]);
    });

    test("releases ports even when disabled-state metadata is retained", () => {
        const panels = new Map<string, PanelEntry>([["svc", { serviceId: "svc", label: "Svc", icon: "square", port: 4321 }]]);
        const sigilPorts = new Map([["svc", 8765]]);
        const released: number[] = [];

        clearServiceRuntimePorts("svc", panels, sigilPorts, true, (port) => released.push(port));

        expect(released.sort()).toEqual([4321, 8765]);
        expect(panels.get("svc")?.port).toBeUndefined();
    });

    test("does not invent a port release for a service that never announced one", () => {
        const panels = new Map<string, PanelEntry>([["svc", { serviceId: "svc", label: "Svc", icon: "square" }]]);
        const released: number[] = [];

        clearServiceRuntimePorts("svc", panels, new Map(), false, (port) => released.push(port));

        expect(released).toEqual([]);
    });
});

describe("planPackageServiceReconcile (fix #4 + addendum B: reconfigure lifecycle)", () => {
    test("revocation: an id no longer in the fresh set is queued for disposal", () => {
        const plan = planPackageServiceReconcile(
            [],
            new Map([["gone", { identity: "npm:gone" }]]),
            () => true,
        );
        expect(plan.revoke).toEqual(["gone"]);
        expect(plan.registerNew).toEqual([]);
    });

    test("unchanged identity + still registered: preserve lifecycle, only refresh metadata", () => {
        const plan = planPackageServiceReconcile(
            [{ id: "svc", identity: "npm:pkg" }],
            new Map([["svc", { identity: "npm:pkg" }]]),
            (id: string) => id === "svc",
        );
        expect(plan.preserveRefreshMetadata).toEqual(["svc"]);
        expect(plan.replaceIdentitySwap).toEqual([]);
        expect(plan.registerNew).toEqual([]);
    });

    test("identity swap: same id, different winning package identity — dispose + replace", () => {
        const plan = planPackageServiceReconcile(
            [{ id: "svc", identity: "npm:new-pkg" }],
            new Map([["svc", { identity: "npm:old-pkg" }]]),
            (id: string) => id === "svc",
        );
        expect(plan.replaceIdentitySwap).toEqual(["svc"]);
        expect(plan.preserveRefreshMetadata).toEqual([]);
    });

    test("re-enable after disable: not in packageServiceIds and not registered — treated as a fresh registration", () => {
        const plan = planPackageServiceReconcile(
            [{ id: "svc", identity: "npm:pkg" }],
            new Map(), // dropped from tracking when disabled
            () => false, // unregistered while disabled
        );
        expect(plan.registerNew).toEqual(["svc"]);
    });

    // An id held by a still-registered handler that package discovery has never
    // mounted can only be a built-in now that legacy origins are gone;
    // registerDiscoveredService()'s built-in guard rejects it downstream.
    test("unknown incumbent: still planned as a fresh registration, guarded downstream", () => {
        const plan = planPackageServiceReconcile(
            [{ id: "svc", identity: "npm:pkg" }],
            new Map(),
            (id: string) => id === "svc",
        );
        expect(plan.registerNew).toEqual(["svc"]);
        expect(plan.replaceIdentitySwap).toEqual([]);
    });

    test("brand new id with no incumbent at all: plain fresh registration", () => {
        const plan = planPackageServiceReconcile(
            [{ id: "svc", identity: "npm:pkg" }],
            new Map(),
            () => false,
        );
        expect(plan.registerNew).toEqual(["svc"]);
    });
});

describe("raceWithTimeout (addendum C: bounded discovery)", () => {
    test("resolves with the real value when the promise settles before the timeout", async () => {
        const result = await raceWithTimeout(Promise.resolve("real"), 50, () => "fallback");
        expect(result).toEqual({ value: "real", timedOut: false });
    });

    test("a never-resolving promise falls back after the timeout instead of hanging forever", async () => {
        const never = new Promise<string>(() => {});
        const result = await raceWithTimeout(never, 20, () => "fallback");
        expect(result).toEqual({ value: "fallback", timedOut: true });
    });

    test("a late resolution after timeout is reported via onLate, not returned as the result", async () => {
        let resolveLate!: (v: string) => void;
        const late = new Promise<string>((r) => { resolveLate = r; });
        const lateValues: string[] = [];
        const resultPromise = raceWithTimeout(late, 10, () => "fallback", (v) => lateValues.push(v));
        const result = await resultPromise;
        expect(result).toEqual({ value: "fallback", timedOut: true });
        resolveLate("too-late");
        await new Promise((r) => setTimeout(r, 5));
        expect(lateValues).toEqual(["too-late"]);
    });
});

describe("timedOutPackageDiscoveryResult (fix #1 + addendum C interaction)", () => {
    test("a timeout fallback is explicitly non-authoritative, matching corrupt-settings semantics", () => {
        const result = timedOutPackageDiscoveryResult("/agent-dir");
        expect(result.authoritative).toBe(false);
        expect(result.services).toEqual([]);
        expect(result.errors[0]?.error).toContain(String(PACKAGE_DISCOVERY_TIMEOUT_MS));
    });
});
