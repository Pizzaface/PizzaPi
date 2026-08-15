import { describe, expect, test } from "bun:test";
import { describeAt, describeCron, describeSchedule, isScheduledTrigger, scheduleMessage } from "./schedule-summary";

describe("isScheduledTrigger", () => {
    test("recognises the time service's triggers only", () => {
        expect(isScheduledTrigger("time:cron")).toBe(true);
        expect(isScheduledTrigger("time:at")).toBe(true);
        expect(isScheduledTrigger("time:timer_fired")).toBe(true);
        expect(isScheduledTrigger("github:pr_comment")).toBe(false);
    });
});

describe("describeCron", () => {
    test("daily", () => {
        expect(describeCron("0 8 * * *")).toBe("Every day at 08:00");
        expect(describeCron("30 17 * * *")).toBe("Every day at 17:30");
    });

    test("weekly and weekday patterns", () => {
        expect(describeCron("0 9 * * 1")).toBe("Every Monday at 09:00");
        expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 09:00");
        expect(describeCron("0 9 * * 1,3,5")).toBe("Mon, Wed, Fri at 09:00");
    });

    test("intervals", () => {
        expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
        expect(describeCron("0 * * * *")).toBe("Every hour");
        expect(describeCron("0 */6 * * *")).toBe("Every 6 hours");
    });

    test("monthly", () => {
        expect(describeCron("0 8 1 * *")).toBe("Monthly on day 1 at 08:00");
    });

    test("falls back to the raw expression when it isn't a shape we phrase", () => {
        expect(describeCron("0 8 * 3 2#1")).toBe("0 8 * 3 2#1");
        expect(describeCron("not cron")).toBe("not cron");
        expect(describeCron("0 8 * *")).toBe("0 8 * *");
    });

    test("rejects out-of-range values rather than inventing a time", () => {
        expect(describeCron("99 99 * * *")).toBe("99 99 * * *");
    });
});

describe("describeAt", () => {
    test("HH:MM shorthand, with and without UTC", () => {
        expect(describeAt("8:00")).toBe("At 08:00");
        expect(describeAt("14:30UTC")).toBe("At 14:30 UTC");
    });

    test("ISO timestamps render as a local date-time", () => {
        const out = describeAt("2026-08-20T09:00:00Z");
        expect(out.startsWith("At ")).toBe(true);
        expect(out).not.toBe("2026-08-20T09:00:00Z");
    });

    test("unparseable input is returned unchanged", () => {
        expect(describeAt("someday")).toBe("someday");
    });
});

describe("describeSchedule", () => {
    test("uses the right param per trigger type", () => {
        expect(describeSchedule("time:cron", { cron: "0 8 * * *" })).toBe("Every day at 08:00");
        expect(describeSchedule("time:at", { at: "9:00" })).toBe("At 09:00");
        expect(describeSchedule("time:timer_fired", { duration: "30m" })).toBe("Once, after 30m");
    });

    test("degrades to the trigger name when params are missing", () => {
        expect(describeSchedule("time:cron", undefined)).toBe("cron");
        expect(describeSchedule("time:at", {})).toBe("at");
    });
});

describe("scheduleMessage", () => {
    test("prefers message, falls back to label, else null", () => {
        expect(scheduleMessage({ message: "Write the daily report" })).toBe("Write the daily report");
        expect(scheduleMessage({ label: "daily" })).toBe("daily");
        expect(scheduleMessage({ message: "   " })).toBeNull();
        expect(scheduleMessage(undefined)).toBeNull();
    });
});
