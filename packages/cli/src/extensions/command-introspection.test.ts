import { describe, expect, test } from "bun:test";
import {
    getCommandIntrospection,
    setRegisteredCommandsProvider,
} from "./command-introspection.js";

describe("command-introspection", () => {
    test("returns empty map when no provider is set", () => {
        setRegisteredCommandsProvider(null as any);
        expect(getCommandIntrospection().size).toBe(0);
    });

    test("snapshots sync completions and argument hints", () => {
        setRegisteredCommandsProvider(() => [
            {
                name: "tool-search",
                invocationName: "tool-search",
                getArgumentCompletions: () => [
                    { value: "status", label: "status" },
                    { value: "reset", label: "reset", description: "Reset deferrals" },
                ],
            },
            { name: "pr-review", argumentHint: "[pr-number]" },
            { name: "plain" }, // no extras — omitted from the map
        ]);

        const map = getCommandIntrospection();
        expect(map.get("tool-search")?.completions).toEqual([
            { value: "status", label: "status", description: undefined },
            { value: "reset", label: "reset", description: "Reset deferrals" },
        ]);
        expect(map.get("pr-review")?.argumentHint).toBe("[pr-number]");
        expect(map.has("plain")).toBe(false);
    });

    test("filters malformed items and survives throwing providers", () => {
        setRegisteredCommandsProvider(() => [
            {
                name: "messy",
                getArgumentCompletions: () => [{ value: "ok" }, { nope: true }, null, "str"],
            },
            {
                name: "boom",
                getArgumentCompletions: () => {
                    throw new Error("nope");
                },
            },
        ]);

        const map = getCommandIntrospection();
        expect(map.get("messy")?.completions).toEqual([
            { value: "ok", label: undefined, description: undefined },
        ]);
        expect(map.has("boom")).toBe(false);
    });

    test("async completions land in the cache for the next snapshot", async () => {
        setRegisteredCommandsProvider(() => [
            {
                name: "slow",
                getArgumentCompletions: () => Promise.resolve([{ value: "later", label: "later" }]),
            },
        ]);

        // First snapshot: promise not yet resolved — no completions.
        expect(getCommandIntrospection().has("slow")).toBe(false);
        await Promise.resolve(); // let the .then() callback run
        // Second snapshot: cached result is now available.
        expect(getCommandIntrospection().get("slow")?.completions).toEqual([
            { value: "later", label: "later", description: undefined },
        ]);
    });
});
