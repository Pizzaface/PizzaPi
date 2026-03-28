import { describe, expect, test } from "bun:test";
import { isSameServiceAnnounce } from "./runner.service-announce.js";

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
});
