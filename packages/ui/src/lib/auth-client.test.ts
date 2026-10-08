import { describe, expect, test } from "bun:test";
import { runMobileSignOutSteps } from "./mobile-sign-out.js";

describe("mobile sign-out steps", () => {
    test("unregisters push before revoking the API key, then clears it even if unregister fails", async () => {
        const calls: string[] = [];

        await runMobileSignOutSteps(
            async () => {
                calls.push("unregister-push");
                throw new Error("network failure");
            },
            async () => {
                calls.push("revoke-key");
            },
            async () => {
                calls.push("clear-key");
            },
        );

        expect(calls).toEqual(["unregister-push", "revoke-key", "clear-key"]);
    });
});
