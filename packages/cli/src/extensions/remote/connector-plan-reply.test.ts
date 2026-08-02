import { describe, test, expect } from "bun:test";
import { mapConnectorPlanReply } from "./connection.js";

describe("mapConnectorPlanReply", () => {
    test("maps approval words to the execute action", () => {
        for (const w of ["begin", "approve", "LGTM", "proceed", "yes", "ship it"]) {
            expect(mapConnectorPlanReply(w)).toBe(JSON.stringify({ action: "execute" }));
        }
        expect(mapConnectorPlanReply("approve please")).toBe(JSON.stringify({ action: "execute" }));
    });

    test("maps cancel words to the cancel action", () => {
        for (const w of ["cancel", "stop", "reject", "no", "abort"]) {
            expect(mapConnectorPlanReply(w)).toBe(JSON.stringify({ action: "cancel" }));
        }
    });

    test("passes anything else through as edit feedback (raw text)", () => {
        expect(mapConnectorPlanReply("tighten step 2 and drop step 3")).toBe("tighten step 2 and drop step 3");
    });
});
