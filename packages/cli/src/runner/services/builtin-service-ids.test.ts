import { describe, expect, test } from "bun:test";
import { BUILTIN_SERVICE_IDS } from "./builtin-service-ids.js";
import { TerminalService } from "./terminal-service.js";
import { FileExplorerService } from "./file-explorer-service.js";
import { GitService } from "./git-service.js";
import { ProcessService } from "./process-service.js";
import { MemoryService } from "./memory-service.js";
import { TimeService } from "./time-service.js";
import { TunnelService } from "./tunnel-service.js";

describe("BUILTIN_SERVICE_IDS", () => {
    test("is the exact set of ids the daemon's built-in constructors produce", () => {
        // Mirrors the exact `new XyzService(...)` calls daemon.ts makes when
        // registering built-ins (ctor args are irrelevant to `.id`).
        const instances = [
            new TerminalService(),
            new FileExplorerService(),
            new GitService(),
            new ProcessService(() => null),
            new MemoryService(() => null),
            new TimeService(),
            new TunnelService(),
        ];
        const actual: Set<string> = new Set(instances.map((s) => s.id));
        expect(actual).toEqual(new Set<string>(BUILTIN_SERVICE_IDS));
        expect(actual.size).toBe(7);
    });

    test("covers exactly the seven documented built-ins", () => {
        expect([...BUILTIN_SERVICE_IDS].sort()).toEqual(
            ["file-explorer", "git", "memory", "process", "terminal", "time", "tunnel"],
        );
    });
});
