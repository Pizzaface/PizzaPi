import { describe, test, expect } from "bun:test";
import { createBootTimer } from "./boot-timing.js";

describe("createBootTimer", () => {
    test("logs elapsed time to stdout format", () => {
        const writes: string[] = [];
        const originalWrite = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: string | Uint8Array) => {
            writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
            return true;
        }) as typeof process.stdout.write;

        try {
            const timer = createBootTimer();
            timer.start("[boot] config");
            timer.end("[boot] config");

            expect(writes).toHaveLength(1);
            expect(writes[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z \[unknown\] \[boot\] config: \d+\.\d{3}ms\n$/);
        } finally {
            process.stdout.write = originalWrite;
        }
    });

    test("missing timer end is a no-op", () => {
        const writes: string[] = [];
        const originalWrite = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: string | Uint8Array) => {
            writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
            return true;
        }) as typeof process.stdout.write;

        try {
            const timer = createBootTimer();
            timer.end("[boot] never-started");
            expect(writes).toHaveLength(0);
        } finally {
            process.stdout.write = originalWrite;
        }
    });
});
