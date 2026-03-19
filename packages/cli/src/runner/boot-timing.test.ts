import { describe, test, expect } from "bun:test";
import { createBootTimer } from "./boot-timing.js";

describe("createBootTimer", () => {
    test("logs elapsed time to stdout format", () => {
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]) => {
            logs.push(args.map(String).join(" "));
        };

        try {
            const timer = createBootTimer();
            timer.start("[boot] config");
            timer.end("[boot] config");

            expect(logs).toHaveLength(1);
            expect(logs[0]).toMatch(/^\[boot\] config: \d+\.\d{3}ms$/);
        } finally {
            console.log = originalLog;
        }
    });

    test("missing timer end is a no-op", () => {
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]) => {
            logs.push(args.map(String).join(" "));
        };

        try {
            const timer = createBootTimer();
            timer.end("[boot] never-started");
            expect(logs).toHaveLength(0);
        } finally {
            console.log = originalLog;
        }
    });
});
