import { describe, expect, test } from "bun:test";
import { chooseServiceAnnounceSeed, isSameServiceAnnounce, shouldSkipServiceAnnounceFanout, computeServiceAnnounceDelta, isEmptyDelta } from "./runner.service-announce.js";

describe("isSameServiceAnnounce", () => {
    test("returns true when serviceIds and panels are identical", () => {
        const left = {
            serviceIds: ["tunnel", "inspector"],
            panels: [
                { serviceId: "tunnel", port: 4173, label: "Tunnel", icon: "globe" },
                { serviceId: "inspector", port: 9229, label: "Inspector", icon: "bug" },
            ],
        };
        const right = {
            serviceIds: ["tunnel", "inspector"],
            panels: [
                { serviceId: "tunnel", port: 4173, label: "Tunnel", icon: "globe" },
                { serviceId: "inspector", port: 9229, label: "Inspector", icon: "bug" },
            ],
        };

        expect(isSameServiceAnnounce(left, right)).toBe(true);
    });

    test("returns false when serviceIds differ", () => {
        const left = { serviceIds: ["tunnel"], panels: [] };
        const right = { serviceIds: ["inspector"], panels: [] };

        expect(isSameServiceAnnounce(left, right)).toBe(false);
    });

    test("returns false when panel metadata differs", () => {
        const left = {
            serviceIds: ["tunnel"],
            panels: [{ serviceId: "tunnel", port: 4173, label: "Tunnel", icon: "globe" }],
        };
        const right = {
            serviceIds: ["tunnel"],
            panels: [{ serviceId: "tunnel", port: 8080, label: "Tunnel", icon: "globe" }],
        };

        expect(isSameServiceAnnounce(left, right)).toBe(false);
    });

    test("returns false when either side is null/undefined", () => {
        const valid = { serviceIds: ["tunnel"], panels: [] };

        expect(isSameServiceAnnounce(null, valid)).toBe(false);
        expect(isSameServiceAnnounce(valid, undefined)).toBe(false);
        expect(isSameServiceAnnounce(undefined, undefined)).toBe(false);
    });

    test("returns true when triggerDefs are identical", () => {
        const left = {
            serviceIds: ["godmother"],
            triggerDefs: [
                { type: "godmother:idea_moved", label: "Idea Moved", description: "Fires when idea moves" },
                { type: "godmother:idea_created", label: "Idea Created" },
            ],
        };
        const right = {
            serviceIds: ["godmother"],
            triggerDefs: [
                { type: "godmother:idea_moved", label: "Idea Moved", description: "Fires when idea moves" },
                { type: "godmother:idea_created", label: "Idea Created" },
            ],
        };

        expect(isSameServiceAnnounce(left, right)).toBe(true);
    });

    test("returns false when triggerDefs differ in type", () => {
        const left = {
            serviceIds: ["godmother"],
            triggerDefs: [{ type: "godmother:idea_moved", label: "Idea Moved" }],
        };
        const right = {
            serviceIds: ["godmother"],
            triggerDefs: [{ type: "godmother:idea_created", label: "Idea Moved" }],
        };

        expect(isSameServiceAnnounce(left, right)).toBe(false);
    });

    test("returns false when triggerDefs count differs", () => {
        const left = {
            serviceIds: ["godmother"],
            triggerDefs: [{ type: "godmother:idea_moved", label: "Idea Moved" }],
        };
        const right = {
            serviceIds: ["godmother"],
            triggerDefs: [
                { type: "godmother:idea_moved", label: "Idea Moved" },
                { type: "godmother:idea_created", label: "Idea Created" },
            ],
        };

        expect(isSameServiceAnnounce(left, right)).toBe(false);
    });

    test("returns false when triggerDef description differs", () => {
        const left = {
            serviceIds: ["svc"],
            triggerDefs: [{ type: "svc:event", label: "Event", description: "old desc" }],
        };
        const right = {
            serviceIds: ["svc"],
            triggerDefs: [{ type: "svc:event", label: "Event", description: "new desc" }],
        };

        expect(isSameServiceAnnounce(left, right)).toBe(false);
    });

    test("treats absent triggerDefs as empty array", () => {
        const withEmpty = { serviceIds: ["svc"], triggerDefs: [] };
        const withUndefined = { serviceIds: ["svc"] };

        expect(isSameServiceAnnounce(withEmpty, withUndefined)).toBe(true);
        expect(isSameServiceAnnounce(withUndefined, withEmpty)).toBe(true);
    });

    test("returns false when triggerDef schema differs", () => {
        const left = {
            serviceIds: ["svc"],
            triggerDefs: [{ type: "svc:event", label: "Event", schema: { type: "object", properties: { id: { type: "string" } } } }],
        };
        const right = {
            serviceIds: ["svc"],
            triggerDefs: [{ type: "svc:event", label: "Event", schema: { type: "object", properties: { id: { type: "number" } } } }],
        };

        expect(isSameServiceAnnounce(left, right)).toBe(false);
    });

    test("returns true when triggerDef schemas are identical", () => {
        const schema = { type: "object", properties: { id: { type: "string" } } };
        const left = { serviceIds: ["svc"], triggerDefs: [{ type: "svc:event", label: "Event", schema }] };
        const right = { serviceIds: ["svc"], triggerDefs: [{ type: "svc:event", label: "Event", schema }] };

        expect(isSameServiceAnnounce(left, right)).toBe(true);
    });

    test("returns false when one def has schema and the other does not", () => {
        const left = {
            serviceIds: ["svc"],
            triggerDefs: [{ type: "svc:event", label: "Event", schema: { type: "object" } }],
        };
        const right = {
            serviceIds: ["svc"],
            triggerDefs: [{ type: "svc:event", label: "Event" }],
        };

        expect(isSameServiceAnnounce(left, right)).toBe(false);
    });

    // ── sigilDefs comparison ─────────────────────────────────────────────

    test("returns true when sigilDefs are identical", () => {
        const base = {
            serviceIds: ["github"],
            sigilDefs: [
                { type: "pr", label: "PR", icon: "git-pull-request", serviceId: "github", resolve: "/api/resolve/pr/{id}" },
            ],
        };
        expect(isSameServiceAnnounce(base, { ...base })).toBe(true);
    });

    test("returns false when sigilDef type differs", () => {
        const left = { serviceIds: ["github"], sigilDefs: [{ type: "pr", label: "PR" }] };
        const right = { serviceIds: ["github"], sigilDefs: [{ type: "issue", label: "PR" }] };
        expect(isSameServiceAnnounce(left, right)).toBe(false);
    });

    test("returns false when sigilDef count differs", () => {
        const left = { serviceIds: ["github"], sigilDefs: [{ type: "pr", label: "PR" }] };
        const right = { serviceIds: ["github"], sigilDefs: [] };
        expect(isSameServiceAnnounce(left, right)).toBe(false);
    });

    test("returns false when sigilDef serviceId differs", () => {
        const left = { serviceIds: ["github"], sigilDefs: [{ type: "pr", label: "PR", serviceId: "github" }] };
        const right = { serviceIds: ["github"], sigilDefs: [{ type: "pr", label: "PR", serviceId: "gitlab" }] };
        expect(isSameServiceAnnounce(left, right)).toBe(false);
    });

    test("returns false when sigilDef icon differs", () => {
        const left = { serviceIds: ["github"], sigilDefs: [{ type: "pr", label: "PR", icon: "git-pull-request" }] };
        const right = { serviceIds: ["github"], sigilDefs: [{ type: "pr", label: "PR", icon: "circle-dot" }] };
        expect(isSameServiceAnnounce(left, right)).toBe(false);
    });

    test("returns false when sigilDef resolve differs", () => {
        const left = { serviceIds: ["github"], sigilDefs: [{ type: "pr", label: "PR", resolve: "/api/v1" }] };
        const right = { serviceIds: ["github"], sigilDefs: [{ type: "pr", label: "PR", resolve: "/api/v2" }] };
        expect(isSameServiceAnnounce(left, right)).toBe(false);
    });

    test("returns false when sigilDef resolvePort differs", () => {
        const left = { serviceIds: ["github"], sigilDefs: [{ type: "pr", label: "PR", resolvePort: 4173 }] };
        const right = { serviceIds: ["github"], sigilDefs: [{ type: "pr", label: "PR", resolvePort: 8080 }] };
        expect(isSameServiceAnnounce(left, right)).toBe(false);
    });

    test("treats absent sigilDefs as empty array", () => {
        const left = { serviceIds: ["github"] };
        const right = { serviceIds: ["github"], sigilDefs: [] };
        expect(isSameServiceAnnounce(left, right)).toBe(true);
    });
});

describe("chooseServiceAnnounceSeed", () => {
    test("uses persisted data when no live announce is cached", () => {
        const persisted = { serviceIds: ["github"] };
        expect(chooseServiceAnnounceSeed(null, persisted)).toEqual(persisted);
    });

    test("keeps the live announce when async seeding loses a race to reconnect", () => {
        const live = { serviceIds: ["github"], sigilDefs: [{ type: "pr", label: "PR", resolvePort: 4173 }] };
        const persisted = { serviceIds: ["github"], sigilDefs: [{ type: "pr", label: "PR", resolvePort: 8080 }] };
        expect(chooseServiceAnnounceSeed(live, persisted)).toEqual(live);
    });
});

describe("shouldSkipServiceAnnounceFanout", () => {
    const announce = {
        serviceIds: ["github"],
        sigilDefs: [{ type: "pr", label: "PR", serviceId: "github", resolve: "/api/resolve/pr/{id}" }],
    };

    test("does not skip the first live announce after reconnect when payload matches cached state", () => {
        expect(shouldSkipServiceAnnounceFanout({
            previous: announce,
            next: announce,
            hasBroadcastLiveAnnounce: false,
        })).toBe(false);
    });

    test("skips redundant announces after a live announce was already broadcast", () => {
        expect(shouldSkipServiceAnnounceFanout({
            previous: announce,
            next: announce,
            hasBroadcastLiveAnnounce: true,
        })).toBe(true);
    });

    test("does not skip when payload changed", () => {
        expect(shouldSkipServiceAnnounceFanout({
            previous: announce,
            next: {
                ...announce,
                sigilDefs: [{ type: "issue", label: "Issue", serviceId: "github", resolve: "/api/resolve/issue/{id}" }],
            },
            hasBroadcastLiveAnnounce: true,
        })).toBe(false);
    });

    test("does not skip when only sigil resolvePort changed", () => {
        expect(shouldSkipServiceAnnounceFanout({
            previous: {
                serviceIds: ["github"],
                sigilDefs: [{ type: "pr", label: "PR", serviceId: "github", resolve: "/api/resolve/pr/{id}", resolvePort: 4173 }],
            },
            next: {
                serviceIds: ["github"],
                sigilDefs: [{ type: "pr", label: "PR", serviceId: "github", resolve: "/api/resolve/pr/{id}", resolvePort: 8080 }],
            },
            hasBroadcastLiveAnnounce: true,
        })).toBe(false);
    });
});

// ── computeServiceAnnounceDelta ──────────────────────────────────────────────

describe("computeServiceAnnounceDelta", () => {
    test("returns null when previous is null", () => {
        expect(computeServiceAnnounceDelta(null, { serviceIds: ["a"] })).toBeNull();
    });

    test("returns null when previous is undefined", () => {
        expect(computeServiceAnnounceDelta(undefined, { serviceIds: ["a"] })).toBeNull();
    });

    test("detects added serviceIds", () => {
        const prev = { serviceIds: ["a"] };
        const next = { serviceIds: ["a", "b"] };
        const delta = computeServiceAnnounceDelta(prev, next)!;
        expect(delta.added.serviceIds).toEqual(["b"]);
        expect(delta.removed.serviceIds).toEqual([]);
    });

    test("detects removed serviceIds", () => {
        const prev = { serviceIds: ["a", "b"] };
        const next = { serviceIds: ["a"] };
        const delta = computeServiceAnnounceDelta(prev, next)!;
        expect(delta.added.serviceIds).toEqual([]);
        expect(delta.removed.serviceIds).toEqual(["b"]);
    });

    test("detects added panels", () => {
        const prev = { serviceIds: ["a"], panels: [] };
        const next = {
            serviceIds: ["a"],
            panels: [{ serviceId: "a", port: 4173, label: "A", icon: "box" }],
        };
        const delta = computeServiceAnnounceDelta(prev, next)!;
        expect(delta.added.panels).toEqual([{ serviceId: "a", port: 4173, label: "A", icon: "box" }]);
        expect(delta.removed.panels).toEqual([]);
        expect(delta.updated.panels).toEqual([]);
    });

    test("detects removed panels", () => {
        const prev = {
            serviceIds: ["a"],
            panels: [{ serviceId: "a", port: 4173, label: "A", icon: "box" }],
        };
        const next = { serviceIds: ["a"], panels: [] };
        const delta = computeServiceAnnounceDelta(prev, next)!;
        expect(delta.added.panels).toEqual([]);
        expect(delta.removed.panels).toEqual(["a"]);
    });

    test("detects updated panels", () => {
        const prev = {
            serviceIds: ["a"],
            panels: [{ serviceId: "a", port: 4173, label: "A", icon: "box" }],
        };
        const next = {
            serviceIds: ["a"],
            panels: [{ serviceId: "a", port: 8080, label: "A", icon: "box" }],
        };
        const delta = computeServiceAnnounceDelta(prev, next)!;
        expect(delta.added.panels).toEqual([]);
        expect(delta.removed.panels).toEqual([]);
        expect(delta.updated.panels).toEqual([{ serviceId: "a", port: 8080, label: "A", icon: "box" }]);
    });

    test("detects added triggerDefs", () => {
        const prev = { serviceIds: ["svc"], triggerDefs: [] };
        const next = {
            serviceIds: ["svc"],
            triggerDefs: [{ type: "svc:event", label: "Event" }],
        };
        const delta = computeServiceAnnounceDelta(prev, next)!;
        expect(delta.added.triggerDefs).toEqual([{ type: "svc:event", label: "Event" }]);
        expect(delta.removed.triggerDefs).toEqual([]);
    });

    test("detects removed triggerDefs", () => {
        const prev = {
            serviceIds: ["svc"],
            triggerDefs: [{ type: "svc:event", label: "Event" }],
        };
        const next = { serviceIds: ["svc"], triggerDefs: [] };
        const delta = computeServiceAnnounceDelta(prev, next)!;
        expect(delta.removed.triggerDefs).toEqual(["svc:event"]);
    });

    test("detects updated triggerDefs (label change)", () => {
        const prev = {
            serviceIds: ["svc"],
            triggerDefs: [{ type: "svc:event", label: "Event" }],
        };
        const next = {
            serviceIds: ["svc"],
            triggerDefs: [{ type: "svc:event", label: "Updated Event" }],
        };
        const delta = computeServiceAnnounceDelta(prev, next)!;
        expect(delta.updated.triggerDefs).toEqual([{ type: "svc:event", label: "Updated Event" }]);
        expect(delta.added.triggerDefs).toEqual([]);
        expect(delta.removed.triggerDefs).toEqual([]);
    });

    test("detects updated triggerDefs (schema change)", () => {
        const prev = {
            serviceIds: ["svc"],
            triggerDefs: [{ type: "svc:event", label: "Event", schema: { type: "object" } }],
        };
        const next = {
            serviceIds: ["svc"],
            triggerDefs: [{ type: "svc:event", label: "Event", schema: { type: "string" } }],
        };
        const delta = computeServiceAnnounceDelta(prev, next)!;
        expect(delta.updated.triggerDefs.length).toBe(1);
        expect(delta.updated.triggerDefs[0].type).toBe("svc:event");
    });

    test("detects added sigilDefs", () => {
        const prev = { serviceIds: ["github"], sigilDefs: [] };
        const next = {
            serviceIds: ["github"],
            sigilDefs: [{ type: "pr", label: "PR", serviceId: "github" }],
        };
        const delta = computeServiceAnnounceDelta(prev, next)!;
        expect(delta.added.sigilDefs).toEqual([{ type: "pr", label: "PR", serviceId: "github" }]);
    });

    test("detects removed sigilDefs", () => {
        const prev = {
            serviceIds: ["github"],
            sigilDefs: [{ type: "pr", label: "PR", serviceId: "github" }],
        };
        const next = { serviceIds: ["github"], sigilDefs: [] };
        const delta = computeServiceAnnounceDelta(prev, next)!;
        expect(delta.removed.sigilDefs).toEqual(["pr"]);
    });

    test("detects updated sigilDefs (resolvePort change)", () => {
        const prev = {
            serviceIds: ["github"],
            sigilDefs: [{ type: "pr", label: "PR", resolvePort: 4173 }],
        };
        const next = {
            serviceIds: ["github"],
            sigilDefs: [{ type: "pr", label: "PR", resolvePort: 8080 }],
        };
        const delta = computeServiceAnnounceDelta(prev, next)!;
        expect(delta.updated.sigilDefs).toEqual([{ type: "pr", label: "PR", resolvePort: 8080 }]);
    });

    test("handles mixed adds, removes, and updates across all categories", () => {
        const prev = {
            serviceIds: ["a", "b"],
            panels: [
                { serviceId: "a", port: 4173, label: "A", icon: "box" },
                { serviceId: "b", port: 5000, label: "B", icon: "cpu" },
            ],
            triggerDefs: [
                { type: "a:event1", label: "Event 1" },
                { type: "b:event2", label: "Event 2" },
            ],
            sigilDefs: [
                { type: "pr", label: "PR" },
                { type: "issue", label: "Issue" },
            ],
        };
        const next = {
            serviceIds: ["a", "c"],
            panels: [
                { serviceId: "a", port: 8080, label: "A-updated", icon: "box" },
                { serviceId: "c", port: 6000, label: "C", icon: "zap" },
            ],
            triggerDefs: [
                { type: "a:event1", label: "Event 1 Updated" },
                { type: "c:event3", label: "Event 3" },
            ],
            sigilDefs: [
                { type: "pr", label: "Pull Request" },
                { type: "commit", label: "Commit" },
            ],
        };
        const delta = computeServiceAnnounceDelta(prev, next)!;

        // Service IDs
        expect(delta.added.serviceIds).toEqual(["c"]);
        expect(delta.removed.serviceIds).toEqual(["b"]);

        // Panels
        expect(delta.added.panels).toEqual([{ serviceId: "c", port: 6000, label: "C", icon: "zap" }]);
        expect(delta.removed.panels).toEqual(["b"]);
        expect(delta.updated.panels).toEqual([{ serviceId: "a", port: 8080, label: "A-updated", icon: "box" }]);

        // TriggerDefs
        expect(delta.added.triggerDefs).toEqual([{ type: "c:event3", label: "Event 3" }]);
        expect(delta.removed.triggerDefs).toEqual(["b:event2"]);
        expect(delta.updated.triggerDefs).toEqual([{ type: "a:event1", label: "Event 1 Updated" }]);

        // SigilDefs
        expect(delta.added.sigilDefs).toEqual([{ type: "commit", label: "Commit" }]);
        expect(delta.removed.sigilDefs).toEqual(["issue"]);
        expect(delta.updated.sigilDefs).toEqual([{ type: "pr", label: "Pull Request" }]);
    });

    test("returns empty delta when nothing changed", () => {
        const data = {
            serviceIds: ["a"],
            panels: [{ serviceId: "a", port: 4173, label: "A", icon: "box" }],
            triggerDefs: [{ type: "a:event", label: "Event" }],
            sigilDefs: [{ type: "pr", label: "PR" }],
        };
        const delta = computeServiceAnnounceDelta(data, data)!;
        expect(isEmptyDelta(delta)).toBe(true);
    });

    test("treats undefined arrays as empty", () => {
        const prev = { serviceIds: ["a"] }; // no panels/triggerDefs/sigilDefs
        const next = { serviceIds: ["a"] };
        const delta = computeServiceAnnounceDelta(prev, next)!;
        expect(isEmptyDelta(delta)).toBe(true);
    });

    test("treats undefined-to-populated as all adds", () => {
        const prev = { serviceIds: ["a"] };
        const next = {
            serviceIds: ["a"],
            panels: [{ serviceId: "a", port: 4173, label: "A", icon: "box" }],
            triggerDefs: [{ type: "a:event", label: "Event" }],
            sigilDefs: [{ type: "pr", label: "PR" }],
        };
        const delta = computeServiceAnnounceDelta(prev, next)!;
        expect(delta.added.panels.length).toBe(1);
        expect(delta.added.triggerDefs.length).toBe(1);
        expect(delta.added.sigilDefs.length).toBe(1);
        expect(delta.removed.panels).toEqual([]);
        expect(delta.removed.triggerDefs).toEqual([]);
        expect(delta.removed.sigilDefs).toEqual([]);
    });
});

// ── isEmptyDelta ─────────────────────────────────────────────────────────────

describe("isEmptyDelta", () => {
    test("returns true for a fully empty delta", () => {
        expect(isEmptyDelta({
            added: { serviceIds: [], panels: [], triggerDefs: [], sigilDefs: [] },
            removed: { serviceIds: [], panels: [], triggerDefs: [], sigilDefs: [] },
            updated: { panels: [], triggerDefs: [], sigilDefs: [] },
        })).toBe(true);
    });

    test("returns false when any field is non-empty", () => {
        const base = {
            added: { serviceIds: [], panels: [], triggerDefs: [], sigilDefs: [] },
            removed: { serviceIds: [], panels: [], triggerDefs: [], sigilDefs: [] },
            updated: { panels: [], triggerDefs: [], sigilDefs: [] },
        };
        expect(isEmptyDelta({ ...base, added: { ...base.added, serviceIds: ["x"] } })).toBe(false);
        expect(isEmptyDelta({ ...base, removed: { ...base.removed, panels: ["x"] } })).toBe(false);
        expect(isEmptyDelta({
            ...base,
            updated: { ...base.updated, sigilDefs: [{ type: "pr", label: "PR" }] },
        })).toBe(false);
    });
});
