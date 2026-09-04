import { describe, test, expect } from "bun:test";
import { parsePanelId, makePanelId, scopePanelIdToRunner, unscopePanelId } from "./panel-instance";

describe("panel-instance", () => {
    test("plain service id has no instance", () => {
        expect(parsePanelId("tunnel")).toEqual({ serviceId: "tunnel" });
    });

    test("round-trips a detached instance id", () => {
        expect(parsePanelId(makePanelId("tunnel", 3000))).toEqual({ serviceId: "tunnel", instance: "3000" });
    });

    test("trailing separator is not an instance", () => {
        expect(parsePanelId("tunnel#")).toEqual({ serviceId: "tunnel", instance: undefined });
    });

    test("parses runner scope without instance", () => {
        expect(parsePanelId("tunnel@runner-1")).toEqual({ serviceId: "tunnel", runnerId: "runner-1" });
    });

    test("parses runner scope with instance", () => {
        expect(parsePanelId("tunnel#3000@runner-1")).toEqual({ serviceId: "tunnel", instance: "3000", runnerId: "runner-1" });
    });

    test("trailing scope separator is not a runner", () => {
        expect(parsePanelId("tunnel@")).toEqual({ serviceId: "tunnel", runnerId: undefined });
    });

    test("scope/unscope round-trip", () => {
        expect(unscopePanelId(scopePanelIdToRunner("tunnel#3000", "r/1"))).toBe("tunnel#3000");
        expect(parsePanelId(scopePanelIdToRunner("tunnel", "r/1")).runnerId).toBe("r/1");
        expect(scopePanelIdToRunner("tunnel", null)).toBe("tunnel");
    });
});
