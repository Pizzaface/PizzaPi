import { describe, test, expect } from "bun:test";
import {
    parseDuration,
    formatDuration,
    formatRelativeTime,
    formatCountdown,
    parseTimeString,
    parseCron,
    nextCronTime,
} from "./time-utils";

// ── parseDuration ────────────────────────────────────────────────────────────

describe("parseDuration", () => {
    test("parses seconds", () => {
        expect(parseDuration("30s")).toBe(30_000);
        expect(parseDuration("1s")).toBe(1_000);
    });

    test("parses minutes", () => {
        expect(parseDuration("10m")).toBe(600_000);
        expect(parseDuration("1m")).toBe(60_000);
    });

    test("parses hours", () => {
        expect(parseDuration("1h")).toBe(3_600_000);
        expect(parseDuration("2h")).toBe(7_200_000);
    });

    test("parses days", () => {
        expect(parseDuration("1d")).toBe(86_400_000);
        expect(parseDuration("2d")).toBe(172_800_000);
    });

    test("parses compound durations", () => {
        expect(parseDuration("1h30m")).toBe(5_400_000);
        expect(parseDuration("1h30m15s")).toBe(5_415_000);
        expect(parseDuration("2d12h")).toBe(216_000_000);
    });

    test("bare number treated as seconds", () => {
        expect(parseDuration("90")).toBe(90_000);
        expect(parseDuration("60")).toBe(60_000);
    });

    test("handles whitespace", () => {
        expect(parseDuration("  10m  ")).toBe(600_000);
    });

    test("case insensitive", () => {
        expect(parseDuration("10M")).toBe(600_000);
        expect(parseDuration("1H")).toBe(3_600_000);
    });

    test("returns null for invalid input", () => {
        expect(parseDuration("")).toBeNull();
        expect(parseDuration("abc")).toBeNull();
        expect(parseDuration("10x")).toBeNull();
        expect(parseDuration("m10")).toBeNull();
    });

    test("returns null for zero duration", () => {
        expect(parseDuration("0s")).toBeNull();
        expect(parseDuration("0")).toBeNull();
    });

    test("handles fractional values", () => {
        expect(parseDuration("1.5h")).toBe(5_400_000);
        expect(parseDuration("0.5m")).toBe(30_000);
    });
});

// ── formatDuration ───────────────────────────────────────────────────────────

describe("formatDuration", () => {
    test("formats seconds", () => {
        expect(formatDuration(5_000)).toBe("5s");
        expect(formatDuration(0)).toBe("0s");
    });

    test("formats minutes", () => {
        expect(formatDuration(120_000)).toBe("2m");
    });

    test("formats hours", () => {
        expect(formatDuration(3_600_000)).toBe("1h");
    });

    test("formats compound", () => {
        expect(formatDuration(5_415_000)).toBe("1h 30m 15s");
    });

    test("formats days", () => {
        expect(formatDuration(90_000_000)).toBe("1d 1h");
    });

    test("handles negative input", () => {
        expect(formatDuration(-1000)).toBe("0s");
    });
});

// ── formatRelativeTime ───────────────────────────────────────────────────────

describe("formatRelativeTime", () => {
    const now = 1_700_000_000_000; // Fixed reference time

    test("just now (within 30s)", () => {
        expect(formatRelativeTime(now, now)).toBe("just now");
        expect(formatRelativeTime(now - 15_000, now)).toBe("just now");
        expect(formatRelativeTime(now + 15_000, now)).toBe("just now");
    });

    test("seconds ago", () => {
        expect(formatRelativeTime(now - 45_000, now)).toBe("45s ago");
    });

    test("minutes ago", () => {
        expect(formatRelativeTime(now - 300_000, now)).toBe("5 min ago");
        expect(formatRelativeTime(now - 60_000, now)).toBe("1 min ago");
    });

    test("hours ago", () => {
        expect(formatRelativeTime(now - 7_200_000, now)).toBe("2 hours ago");
        expect(formatRelativeTime(now - 3_600_000, now)).toBe("1 hour ago");
    });

    test("days ago", () => {
        expect(formatRelativeTime(now - 172_800_000, now)).toBe("2 days ago");
    });

    test("future - seconds", () => {
        expect(formatRelativeTime(now + 45_000, now)).toBe("In 45s");
    });

    test("future - minutes", () => {
        expect(formatRelativeTime(now + 300_000, now)).toBe("In 5 min");
    });

    test("future - hours", () => {
        expect(formatRelativeTime(now + 7_200_000, now)).toBe("In 2 hours");
    });

    test("future - days", () => {
        expect(formatRelativeTime(now + 172_800_000, now)).toBe("In 2 days");
    });

    test("old dates show month/day", () => {
        // 60 days ago
        const result = formatRelativeTime(now - 60 * 86_400_000, now);
        expect(result).toMatch(/^[A-Z][a-z]+ \d+$/);
    });
});

// ── formatCountdown ──────────────────────────────────────────────────────────

describe("formatCountdown", () => {
    const now = 1_700_000_000_000;

    test("shows Done! when target has passed", () => {
        expect(formatCountdown(now - 1000, now)).toBe("Done!");
        expect(formatCountdown(now, now)).toBe("Done!");
    });

    test("shows minutes and seconds", () => {
        expect(formatCountdown(now + 300_000, now)).toBe("T-5:00");
        expect(formatCountdown(now + 65_000, now)).toBe("T-1:05");
    });

    test("shows hours, minutes, and seconds", () => {
        expect(formatCountdown(now + 5_400_000, now)).toBe("T-1:30:00");
    });

    test("shows seconds only for short durations", () => {
        expect(formatCountdown(now + 5_000, now)).toBe("T-0:05");
    });

    test("single second remaining", () => {
        expect(formatCountdown(now + 1_000, now)).toBe("T-0:01");
    });
});

// ── parseTimeString ──────────────────────────────────────────────────────────

describe("parseTimeString", () => {
    const now = 1_700_000_000_000;

    test("parses ISO 8601", () => {
        const result = parseTimeString("2023-11-14T22:13:20.000Z", now);
        expect(result).toBe(1_700_000_000_000);
    });

    test("parses HH:MMUTC", () => {
        const result = parseTimeString("14:30UTC", now);
        expect(result).not.toBeNull();
        const date = new Date(result!);
        expect(date.getUTCHours()).toBe(14);
        expect(date.getUTCMinutes()).toBe(30);
    });

    test("parses unix timestamp (seconds)", () => {
        expect(parseTimeString("1700000000", now)).toBe(1_700_000_000_000);
    });

    test("parses unix timestamp (milliseconds)", () => {
        expect(parseTimeString("1700000000000", now)).toBe(1_700_000_000_000);
    });

    test("parses relative duration", () => {
        const result = parseTimeString("5m", now);
        expect(result).toBe(now + 300_000);
    });

    test("parses +prefixed duration", () => {
        const result = parseTimeString("+10m", now);
        expect(result).toBe(now + 600_000);
    });

    test("returns null for invalid input", () => {
        expect(parseTimeString("", now)).toBeNull();
        expect(parseTimeString("not-a-time", now)).toBeNull();
    });
});

// ── parseCron ────────────────────────────────────────────────────────────────

describe("parseCron", () => {
    test("parses simple cron", () => {
        const cron = parseCron("*/15 * * * *");
        expect(cron).not.toBeNull();
        expect(cron!.minutes.size).toBe(4); // 0, 15, 30, 45
        expect(cron!.minutes.has(0)).toBe(true);
        expect(cron!.minutes.has(15)).toBe(true);
        expect(cron!.minutes.has(30)).toBe(true);
        expect(cron!.minutes.has(45)).toBe(true);
    });

    test("parses specific values", () => {
        const cron = parseCron("0 9 * * 1-5");
        expect(cron).not.toBeNull();
        expect(cron!.minutes.has(0)).toBe(true);
        expect(cron!.minutes.size).toBe(1);
        expect(cron!.hours.has(9)).toBe(true);
        expect(cron!.hours.size).toBe(1);
        expect(cron!.daysOfWeek.size).toBe(5);
    });

    test("parses lists", () => {
        const cron = parseCron("0,30 * * * *");
        expect(cron).not.toBeNull();
        expect(cron!.minutes.size).toBe(2);
        expect(cron!.minutes.has(0)).toBe(true);
        expect(cron!.minutes.has(30)).toBe(true);
    });

    test("parses ranges", () => {
        const cron = parseCron("0 9-17 * * *");
        expect(cron).not.toBeNull();
        expect(cron!.hours.size).toBe(9);
    });

    test("parses wildcards", () => {
        const cron = parseCron("* * * * *");
        expect(cron).not.toBeNull();
        expect(cron!.minutes.size).toBe(60);
        expect(cron!.hours.size).toBe(24);
    });

    test("returns null for invalid expressions", () => {
        expect(parseCron("")).toBeNull();
        expect(parseCron("* * *")).toBeNull();
        expect(parseCron("60 * * * *")).toBeNull();
        expect(parseCron("* 25 * * *")).toBeNull();
    });
});

// ── nextCronTime ─────────────────────────────────────────────────────────────

describe("nextCronTime", () => {
    test("finds next minute match", () => {
        const cron = parseCron("*/15 * * * *")!;
        // Start at 14:07 UTC
        const start = new Date("2026-03-30T14:07:00Z").getTime();
        const next = nextCronTime(cron, start);
        expect(next).not.toBeNull();
        const nextDate = new Date(next!);
        expect(nextDate.getUTCMinutes()).toBe(15);
        expect(nextDate.getUTCHours()).toBe(14);
    });

    test("finds next hour match", () => {
        const cron = parseCron("0 9 * * *")!;
        // Start at 10:00 UTC
        const start = new Date("2026-03-30T10:00:00Z").getTime();
        const next = nextCronTime(cron, start);
        expect(next).not.toBeNull();
        const nextDate = new Date(next!);
        expect(nextDate.getUTCHours()).toBe(9);
        // Should be the next day
        expect(nextDate.getUTCDate()).toBe(31);
    });

    test("respects day-of-week", () => {
        // Only on Mondays (1)
        const cron = parseCron("0 9 * * 1")!;
        // Start on a Sunday
        const start = new Date("2026-03-29T10:00:00Z").getTime(); // Sunday
        const next = nextCronTime(cron, start);
        expect(next).not.toBeNull();
        const nextDate = new Date(next!);
        expect(nextDate.getUTCDay()).toBe(1); // Monday
    });

    test("returns null for impossible expressions", () => {
        // February 31st will never match
        const cron = parseCron("0 0 31 2 *")!;
        const next = nextCronTime(cron);
        expect(next).toBeNull();
    });
});
