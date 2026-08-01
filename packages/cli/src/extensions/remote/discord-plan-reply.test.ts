import { describe, test, expect } from "bun:test";
import { mapDiscordPlanReply } from "./connection.js";

describe("mapDiscordPlanReply", () => {
    test("maps approval words to the execute action", () => {
        for (const w of ["begin", "approve", "LGTM", "proceed", "yes", "ship it"]) {
            expect(mapDiscordPlanReply(w)).toBe(JSON.stringify({ action: "execute" }));
        }
        expect(mapDiscordPlanReply("approve please")).toBe(JSON.stringify({ action: "execute" }));
    });

    test("maps cancel words to the cancel action", () => {
        for (const w of ["cancel", "stop", "reject", "no", "abort"]) {
            expect(mapDiscordPlanReply(w)).toBe(JSON.stringify({ action: "cancel" }));
        }
    });

    test("passes anything else through as edit feedback (raw text)", () => {
        expect(mapDiscordPlanReply("tighten step 2 and drop step 3")).toBe("tighten step 2 and drop step 3");
    });
});
