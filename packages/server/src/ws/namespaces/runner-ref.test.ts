import { describe, expect, it } from "bun:test";
import { isRunnerRefServiceAnnounce, withRunnerRefHint } from "./runner-ref.js";

describe("withRunnerRefHint", () => {
    it("adds runnerId and the _runnerRef flag", () => {
        const hinted = withRunnerRefHint("runner-123", {
            serviceIds: ["tunnel"],
            panels: [{ serviceId: "tunnel", port: 4173, label: "Tunnel", icon: "globe" }],
        });

        expect(hinted.runnerId).toBe("runner-123");
        expect(hinted._runnerRef).toBe(true);
        expect(hinted.serviceIds).toEqual(["tunnel"]);
    });
});

describe("isRunnerRefServiceAnnounce", () => {
    it("recognizes hinted service announces", () => {
        expect(isRunnerRefServiceAnnounce({
            runnerId: "runner-123",
            _runnerRef: true,
            serviceIds: [],
        })).toBe(true);
    });

    it("rejects ordinary announces", () => {
        expect(isRunnerRefServiceAnnounce({ serviceIds: [] })).toBe(false);
        expect(isRunnerRefServiceAnnounce(null)).toBe(false);
    });
});
