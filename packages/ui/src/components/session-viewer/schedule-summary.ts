/**
 * Human-readable descriptions of standing time-based instructions.
 *
 * A mode's scheduled surface should say "Every day at 08:00", not
 * `time:cron {"cron":"0 8 * * *"}`. Pure so the phrasing is testable.
 */

/** Trigger types the scheduled surface understands. */
export const SCHEDULED_TRIGGER_TYPES = ["time:cron", "time:at", "time:timer_fired"] as const;

/** True when a trigger type represents standing scheduled work. */
export function isScheduledTrigger(triggerType: string): boolean {
  return (SCHEDULED_TRIGGER_TYPES as readonly string[]).includes(triggerType);
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHLY = "Monthly";

/** Zero-padded HH:MM from cron minute/hour fields, or null if not literal. */
function literalTime(minute: string, hour: string): string | null {
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  const m = Number(minute);
  const h = Number(hour);
  if (m > 59 || h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} UTC`;
}

/**
 * Describe a 5-field cron expression.
 *
 * ponytail: covers the shapes a person actually writes for standing work
 * (daily, weekly, monthly, hourly, every-N-minutes) and falls back to the raw
 * expression otherwise — a full cron-to-English parser is not worth it here.
 */
export function describeCron(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string];

  const everyMinute = minute.startsWith("*/") ? Number(minute.slice(2)) : null;
  const everyHour = hour.startsWith("*/") ? Number(hour.slice(2)) : null;
  const time = literalTime(minute, hour);
  const anyDate = dayOfMonth === "*" && month === "*";

  if (everyMinute && hour === "*" && anyDate && dayOfWeek === "*") {
    return `Every ${everyMinute} minutes`;
  }
  if (minute === "0" && hour === "*" && anyDate && dayOfWeek === "*") return "Every hour";
  if (everyHour && /^\d{1,2}$/.test(minute) && anyDate && dayOfWeek === "*") {
    return `Every ${everyHour} hours`;
  }

  if (time && anyDate) {
    if (dayOfWeek === "*") return `Every day at ${time}`;
    if (/^\d$/.test(dayOfWeek)) return `Every ${DAY_NAMES[Number(dayOfWeek) % 7]} at ${time}`;
    if (dayOfWeek === "1-5") return `Weekdays at ${time}`;
    if (/^[0-6](,[0-6])+$/.test(dayOfWeek)) {
      const days = dayOfWeek.split(",").map((d) => DAY_NAMES[Number(d) % 7]!.slice(0, 3));
      return `${days.join(", ")} at ${time}`;
    }
  }

  if (time && /^\d{1,2}$/.test(dayOfMonth) && month === "*" && dayOfWeek === "*") {
    return `${MONTHLY} on day ${Number(dayOfMonth)} at ${time}`;
  }

  return expression;
}

/** Describe an absolute time, in the viewer's locale. */
export function describeAt(value: string): string {
  // "HH:MM" / "HH:MMUTC" shorthand, as accepted by the time service.
  const shorthand = /^(\d{1,2}):(\d{2})\s*UTC$/i.exec(value.trim());
  if (shorthand) {
    const [, h, m] = shorthand;
    const hour = Number(h);
    const minute = Number(m);
    if (hour < 24 && minute < 60) return `At ${String(hour).padStart(2, "0")}:${m} UTC`;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return `At ${new Date(parsed).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

/** One-line description of a scheduled subscription's cadence. */
export function describeSchedule(
  triggerType: string,
  params: Record<string, unknown> | undefined,
): string {
  const cron = typeof params?.cron === "string" ? params.cron : null;
  const at = typeof params?.at === "string" ? params.at : null;
  const duration = typeof params?.duration === "string" ? params.duration : null;

  if (triggerType === "time:cron" && cron) return describeCron(cron);
  if (triggerType === "time:at" && at) return describeAt(at);
  if (triggerType === "time:timer_fired" && duration) return `Once, after ${duration}`;
  return triggerType.replace(/^time:/, "");
}

/** What the schedule will say when it fires, if anything was configured. */
export function scheduleMessage(params: Record<string, unknown> | undefined): string | null {
  const message = typeof params?.message === "string" ? params.message.trim() : "";
  if (message) return message;
  const label = typeof params?.label === "string" ? params.label.trim() : "";
  return label || null;
}
