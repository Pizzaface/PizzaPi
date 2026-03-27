import { describe, expect, test } from "bun:test";
import { isSameServiceAnnounce } from "./runner.js";

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
});
