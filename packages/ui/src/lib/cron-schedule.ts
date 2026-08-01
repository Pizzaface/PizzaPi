/**
 * Local-time recurring schedules ↔ UTC cron expressions.
 *
 * The runner evaluates cron in UTC, but users think in local time. These
 * helpers convert a simple daily/weekly/monthly schedule (in the browser's
 * timezone) to a 5-field UTC cron string and back, handling day-of-week /
 * day-of-month shifts when the local↔UTC conversion crosses midnight.
 */

export interface RecurringSchedule {
    freq: "daily" | "weekly" | "monthly";
    /** Local hour 0-23 */
    hour: number;
    /** Local minute 0-59 */
    minute: number;
    /** Local weekday 0-6 (weekly) or day-of-month 1-31 (monthly). Ignored for daily. */
    day: number;
}

// Reference dates in January (31 days) so day-of-month arithmetic is safe.
// ponytail: "monthly on the 31st" near a local↔UTC midnight boundary is not
// representable as a single UTC cron — the converted dom is only exact for
// 31-day months. Fine for the common 1st-28th + daytime cases.
const REF_YEAR = 2026;

/** Convert a local-time schedule to a 5-field UTC cron expression. */
export function cronFromSchedule(s: RecurringSchedule): string {
    if (s.freq === "daily") {
        const d = new Date(REF_YEAR, 0, 15, s.hour, s.minute);
        return `${d.getUTCMinutes()} ${d.getUTCHours()} * * *`;
    }
    if (s.freq === "weekly") {
        // Walk to a reference date whose *local* weekday matches, then read UTC fields.
        const d = new Date(REF_YEAR, 0, 10, s.hour, s.minute);
        while (d.getDay() !== ((s.day % 7) + 7) % 7) d.setDate(d.getDate() + 1);
        return `${d.getUTCMinutes()} ${d.getUTCHours()} * * ${d.getUTCDay()}`;
    }
    // monthly
    const dom = Math.min(31, Math.max(1, Math.round(s.day)));
    const d = new Date(REF_YEAR, 0, dom, s.hour, s.minute);
    return `${d.getUTCMinutes()} ${d.getUTCHours()} ${d.getUTCDate()} * *`;
}

/**
 * Parse a 5-field UTC cron back into a local-time schedule.
 * Returns null for anything the simple builder can't represent
 * (steps, ranges, lists, month restrictions, non-integer fields).
 */
export function scheduleFromCron(cron: string): RecurringSchedule | null {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [m, h, dom, mon, dow] = parts;
    if (mon !== "*") return null;
    if (!/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(h)) return null;
    const minute = Number(m);
    const hour = Number(h);
    if (minute > 59 || hour > 23) return null;

    if (dom === "*" && dow === "*") {
        const d = new Date(Date.UTC(REF_YEAR, 0, 15, hour, minute));
        return { freq: "daily", hour: d.getHours(), minute: d.getMinutes(), day: 0 };
    }
    if (dom === "*" && /^[0-6]$/.test(dow)) {
        const d = new Date(Date.UTC(REF_YEAR, 0, 10, hour, minute));
        while (d.getUTCDay() !== Number(dow)) d.setUTCDate(d.getUTCDate() + 1);
        return { freq: "weekly", hour: d.getHours(), minute: d.getMinutes(), day: d.getDay() };
    }
    if (dow === "*" && /^([1-9]|[12]\d|3[01])$/.test(dom)) {
        const d = new Date(Date.UTC(REF_YEAR, 0, Number(dom), hour, minute));
        return { freq: "monthly", hour: d.getHours(), minute: d.getMinutes(), day: d.getDate() };
    }
    return null;
}
