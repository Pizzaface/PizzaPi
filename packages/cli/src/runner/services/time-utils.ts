/**
 * Time utilities for the built-in Time service.
 *
 * - Duration parsing: "10m", "1h30m", "30s", "2h" → milliseconds
 * - Cron parsing: minute-level cron expressions → next fire time
 * - Relative time formatting: timestamp → "5 min ago", "In 2 hours"
 * - Time string parsing: ISO 8601, "HH:MMUTC", Unix timestamps → Date
 */

// ── Duration parsing ─────────────────────────────────────────────────────────

/**
 * Parse a human-friendly duration string into milliseconds.
 *
 * Supported formats:
 *   "30s"      → 30_000
 *   "10m"      → 600_000
 *   "1h"       → 3_600_000
 *   "1h30m"    → 5_400_000
 *   "2d"       → 172_800_000
 *   "1h30m15s" → 5_415_000
 *   "90"       → 90_000  (bare number = seconds)
 *
 * Returns null for invalid input.
 */
export function parseDuration(input: string): number | null {
    if (!input || typeof input !== "string") return null;

    const trimmed = input.trim().toLowerCase();
    if (!trimmed) return null;

    // Bare number → treat as seconds
    if (/^\d+$/.test(trimmed)) {
        const val = parseInt(trimmed, 10) * 1000;
        return val > 0 ? val : null;
    }

    const UNIT_MS: Record<string, number> = {
        s: 1_000,
        m: 60_000,
        h: 3_600_000,
        d: 86_400_000,
    };

    // Match repeated (number + unit) groups
    const pattern = /(\d+(?:\.\d+)?)\s*(s|m|h|d)/g;
    let total = 0;
    let matched = false;
    let lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(trimmed)) !== null) {
        // Check there's no garbage between matches
        const between = trimmed.slice(lastIndex, match.index).trim();
        if (between.length > 0) return null;

        const value = parseFloat(match[1]);
        const unit = match[2];
        total += value * UNIT_MS[unit];
        matched = true;
        lastIndex = pattern.lastIndex;
    }

    // Check no trailing garbage
    if (matched && trimmed.slice(lastIndex).trim().length > 0) return null;

    return matched && total > 0 ? Math.round(total) : null;
}

/**
 * Format milliseconds as a compact duration string.
 * e.g. 5_415_000 → "1h 30m 15s"
 */
export function formatDuration(ms: number): string {
    if (ms < 0) ms = 0;
    const parts: string[] = [];

    const d = Math.floor(ms / 86_400_000);
    if (d > 0) { parts.push(`${d}d`); ms %= 86_400_000; }

    const h = Math.floor(ms / 3_600_000);
    if (h > 0) { parts.push(`${h}h`); ms %= 3_600_000; }

    const m = Math.floor(ms / 60_000);
    if (m > 0) { parts.push(`${m}m`); ms %= 60_000; }

    const s = Math.floor(ms / 1_000);
    if (s > 0 || parts.length === 0) parts.push(`${s}s`);

    return parts.join(" ");
}

// ── Relative time formatting ─────────────────────────────────────────────────

/**
 * Format a timestamp as a human-readable relative time string.
 *
 * Examples:
 *   - "just now"      (within 30s)
 *   - "30s ago"       (within 1m)
 *   - "5 min ago"     (within 1h)
 *   - "2 hours ago"   (within 1d)
 *   - "3 days ago"    (within 30d)
 *   - "Mar 15"        (older, same year)
 *   - "Mar 15, 2025"  (older, different year)
 *
 *   Future:
 *   - "In 30s"
 *   - "In 5 min"
 *   - "In 2 hours"
 *   - etc.
 */
export function formatRelativeTime(targetMs: number, nowMs?: number): string {
    const now = nowMs ?? Date.now();
    const diffMs = now - targetMs;
    const absDiff = Math.abs(diffMs);
    const isFuture = diffMs < 0;

    if (absDiff < 30_000) return "just now";

    const seconds = Math.floor(absDiff / 1000);
    const minutes = Math.floor(absDiff / 60_000);
    const hours = Math.floor(absDiff / 3_600_000);
    const days = Math.floor(absDiff / 86_400_000);

    const wrap = (s: string) => isFuture ? `In ${s}` : `${s} ago`;

    if (seconds < 60) return wrap(`${seconds}s`);
    if (minutes < 60) return wrap(`${minutes} min`);
    if (hours < 24) return wrap(`${hours} hour${hours !== 1 ? "s" : ""}`);
    if (days < 30) return wrap(`${days} day${days !== 1 ? "s" : ""}`);

    // Absolute date for anything older than 30 days
    const date = new Date(targetMs);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthStr = months[date.getMonth()];
    const day = date.getDate();
    const year = date.getFullYear();
    const currentYear = new Date(now).getFullYear();

    if (year === currentYear) {
        return isFuture ? `${monthStr} ${day}` : `${monthStr} ${day}`;
    }
    return `${monthStr} ${day}, ${year}`;
}

// ── Countdown formatting ─────────────────────────────────────────────────────

/**
 * Format a countdown from now to a target time.
 *
 * Returns:
 *   "T-5:00"   (5 minutes remaining)
 *   "T-0:05"   (5 seconds remaining)
 *   "T-1:30:00" (1h 30m remaining)
 *   "Done!"    (past target)
 */
export function formatCountdown(targetMs: number, nowMs?: number): string {
    const now = nowMs ?? Date.now();
    const remaining = targetMs - now;

    if (remaining <= 0) return "Done!";

    const totalSeconds = Math.ceil(remaining / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const pad = (n: number) => n.toString().padStart(2, "0");

    if (hours > 0) {
        return `T-${hours}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `T-${minutes}:${pad(seconds)}`;
}

// ── Time string parsing ──────────────────────────────────────────────────────

/**
 * Parse a time string into a Unix timestamp (milliseconds).
 *
 * Supported formats:
 *   - ISO 8601: "2026-03-30T08:00:00Z"
 *   - HH:MMUTC: "14:30UTC" → today at 14:30 UTC (or tomorrow if past)
 *   - Unix timestamp (seconds): "1711800000"
 *   - Unix timestamp (ms): "1711800000000"
 *   - Relative duration: "5m" → 5 minutes from now
 *   - Relative duration: "+5m" → 5 minutes from now
 *
 * Returns null for invalid input.
 */
export function parseTimeString(input: string, nowMs?: number): number | null {
    if (!input || typeof input !== "string") return null;
    const trimmed = input.trim();
    if (!trimmed) return null;

    const now = nowMs ?? Date.now();

    // ISO 8601
    const isoDate = new Date(trimmed);
    if (!isNaN(isoDate.getTime()) && /^\d{4}-/.test(trimmed)) {
        return isoDate.getTime();
    }

    // HH:MMUTC format (e.g. "14:30UTC", "00:00UTC")
    const utcMatch = trimmed.match(/^(\d{1,2}):(\d{2})\s*UTC$/i);
    if (utcMatch) {
        const hours = parseInt(utcMatch[1], 10);
        const minutes = parseInt(utcMatch[2], 10);
        if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
            const today = new Date(now);
            today.setUTCHours(hours, minutes, 0, 0);
            // If the time has already passed today, use it as-is (show "ago")
            return today.getTime();
        }
    }

    // Unix timestamp (seconds or milliseconds)
    if (/^\d{10,13}$/.test(trimmed)) {
        const num = parseInt(trimmed, 10);
        // 13 digits = milliseconds, 10 digits = seconds
        return trimmed.length >= 13 ? num : num * 1000;
    }

    // Relative duration with optional + prefix
    const relInput = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
    const durationMs = parseDuration(relInput);
    if (durationMs !== null) {
        return now + durationMs;
    }

    return null;
}

// ── Cron parsing ─────────────────────────────────────────────────────────────

/**
 * A parsed cron expression (minute-level precision).
 * Standard 5-field: minute hour day-of-month month day-of-week
 */
export interface CronExpression {
    minutes: Set<number>;
    hours: Set<number>;
    daysOfMonth: Set<number>;
    months: Set<number>;
    daysOfWeek: Set<number>;
}

/**
 * Parse a cron expression string into a CronExpression.
 * Supports: *, ranges (1-5), lists (1,3,5), steps (*​/15, 1-10/2).
 *
 * Returns null for invalid expressions.
 */
export function parseCron(expression: string): CronExpression | null {
    if (!expression || typeof expression !== "string") return null;
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const parseField = (field: string, min: number, max: number): Set<number> | null => {
        const values = new Set<number>();

        for (const segment of field.split(",")) {
            // Step: */N or range/N
            const stepMatch = segment.match(/^(.+)\/(\d+)$/);
            let range: string;
            let step: number;

            if (stepMatch) {
                range = stepMatch[1];
                step = parseInt(stepMatch[2], 10);
                if (isNaN(step) || step <= 0) return null;
            } else {
                range = segment;
                step = 1;
            }

            if (range === "*") {
                for (let i = min; i <= max; i += step) values.add(i);
            } else if (range.includes("-")) {
                const [startStr, endStr] = range.split("-");
                const start = parseInt(startStr, 10);
                const end = parseInt(endStr, 10);
                if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) return null;
                for (let i = start; i <= end; i += step) values.add(i);
            } else {
                const val = parseInt(range, 10);
                if (isNaN(val) || val < min || val > max) return null;
                values.add(val);
            }
        }

        return values.size > 0 ? values : null;
    };

    const minutes = parseField(parts[0], 0, 59);
    const hours = parseField(parts[1], 0, 23);
    const daysOfMonth = parseField(parts[2], 1, 31);
    const months = parseField(parts[3], 1, 12);
    const daysOfWeek = parseField(parts[4], 0, 6);

    if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;

    return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

/**
 * Get the next fire time for a cron expression after the given time.
 * Searches up to 366 days ahead. Returns null if no match found.
 */
export function nextCronTime(cron: CronExpression, afterMs?: number): number | null {
    const after = new Date(afterMs ?? Date.now());
    // Start from the next whole minute
    after.setUTCSeconds(0, 0);
    after.setUTCMinutes(after.getUTCMinutes() + 1);

    const limit = 366 * 24 * 60; // max iterations (1 year of minutes)

    for (let i = 0; i < limit; i++) {
        const month = after.getUTCMonth() + 1; // 1-indexed
        const dayOfMonth = after.getUTCDate();
        const dayOfWeek = after.getUTCDay(); // 0=Sunday
        const hour = after.getUTCHours();
        const minute = after.getUTCMinutes();

        if (
            cron.months.has(month) &&
            cron.daysOfMonth.has(dayOfMonth) &&
            cron.daysOfWeek.has(dayOfWeek) &&
            cron.hours.has(hour) &&
            cron.minutes.has(minute)
        ) {
            return after.getTime();
        }

        after.setUTCMinutes(after.getUTCMinutes() + 1);
    }

    return null;
}
