import { describe, expect, test } from "bun:test";
import { formatCurrentTime } from "./current-time.js";

describe("formatCurrentTime", () => {
    test("includes local time, ISO UTC, and timezone", () => {
        const now = new Date("2026-07-20T15:30:45Z");
        const text = formatCurrentTime(now);
        expect(text).toContain("Local: ");
        expect(text).toContain("ISO (UTC): 2026-07-20T15:30:45.000Z");
        expect(text).toContain(`Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
        expect(text).toContain("2026");
    });
});
