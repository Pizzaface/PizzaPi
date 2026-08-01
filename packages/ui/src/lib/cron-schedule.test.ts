import { describe, test, expect } from "bun:test";
import { cronFromSchedule, scheduleFromCron, type RecurringSchedule } from "./cron-schedule.js";

// Tests run in whatever timezone the machine has — assertions are round-trip
// based so they hold in any timezone, plus a few structural checks.

describe("cronFromSchedule", () => {
    test("daily produces '* *' dom/dow", () => {
        const cron = cronFromSchedule({ freq: "daily", hour: 9, minute: 30, day: 0 });
        expect(cron).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
    });

    test("weekly produces a single dow 0-6", () => {
        const cron = cronFromSchedule({ freq: "weekly", hour: 9, minute: 0, day: 1 });
        expect(cron).toMatch(/^\d{1,2} \d{1,2} \* \* [0-6]$/);
    });

    test("monthly produces a dom 1-31", () => {
        const cron = cronFromSchedule({ freq: "monthly", hour: 8, minute: 15, day: 14 });
        expect(cron).toMatch(/^\d{1,2} \d{1,2} ([1-9]|[12]\d|3[01]) \* \*$/);
    });

    test("monthly clamps day into 1-31", () => {
        expect(scheduleFromCron(cronFromSchedule({ freq: "monthly", hour: 12, minute: 0, day: 99 }))?.day).toBe(31);
        expect(scheduleFromCron(cronFromSchedule({ freq: "monthly", hour: 12, minute: 0, day: 0 }))?.day).toBe(1);
    });
});

describe("round-trips (local ↔ UTC)", () => {
    const cases: RecurringSchedule[] = [
        { freq: "daily", hour: 0, minute: 0, day: 0 },
        { freq: "daily", hour: 23, minute: 59, day: 0 },
        { freq: "daily", hour: 9, minute: 30, day: 0 },
        { freq: "weekly", hour: 0, minute: 5, day: 0 },   // Sunday just after local midnight
        { freq: "weekly", hour: 23, minute: 55, day: 6 }, // Saturday just before local midnight
        { freq: "weekly", hour: 12, minute: 0, day: 3 },
        { freq: "monthly", hour: 1, minute: 0, day: 1 },
        { freq: "monthly", hour: 22, minute: 0, day: 15 },
    ];

    for (const s of cases) {
        test(`${s.freq} ${s.hour}:${s.minute} day=${s.day} survives schedule→cron→schedule`, () => {
            const back = scheduleFromCron(cronFromSchedule(s));
            expect(back).toEqual({ ...s, day: s.freq === "daily" ? 0 : s.day });
        });
    }

    test("cron→schedule→cron is stable for representable crons", () => {
        for (const cron of ["0 9 * * *", "30 14 * * 1", "0 0 15 * *", "59 23 * * 6", "0 6 1 * *"]) {
            const sched = scheduleFromCron(cron);
            expect(sched).not.toBeNull();
            expect(cronFromSchedule(sched!)).toBe(cron);
        }
    });
});

describe("scheduleFromCron rejects what the builder can't represent", () => {
    const unrepresentable = [
        "*/30 * * * *",     // step
        "0 9 * * 1-5",      // range
        "0 9 * * 1,3",      // list
        "0 9 1 6 *",        // month restriction
        "0 9 1 * 1",        // both dom and dow
        "0 9 * *",          // 4 fields
        "x 9 * * *",        // junk
        "0 25 * * *",       // hour out of range
        "60 9 * * *",       // minute out of range
    ];
    for (const cron of unrepresentable) {
        test(`"${cron}" → null`, () => {
            expect(scheduleFromCron(cron)).toBeNull();
        });
    }
});
