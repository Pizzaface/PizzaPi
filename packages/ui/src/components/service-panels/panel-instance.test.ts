import { describe, test, expect } from "bun:test";
import { parsePanelId, makePanelId } from "./panel-instance";

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
});
