import { logInfo } from "./logger.js";

type TimerEntry = {
    label: string;
    startedAtMs: number;
};

/**
 * Lightweight boot timer that logs to stdout via the runner logger.
 *
 * Node/Bun's console.timeEnd() writes to stderr, which causes normal
 * boot instrumentation to appear as error logs when workers are spawned
 * with inherited stdio. This helper keeps timing output on stdout.
 */
export function createBootTimer(): {
    start: (name: string) => void;
    end: (name: string) => void;
} {
    const timers = new Map<string, TimerEntry>();

    return {
        start(name: string) {
            timers.set(name, { label: name, startedAtMs: performance.now() });
        },
        end(name: string) {
            const timer = timers.get(name);
            if (!timer) return;
            timers.delete(name);
            const elapsedMs = performance.now() - timer.startedAtMs;
            logInfo(`${timer.label}: ${elapsedMs.toFixed(3)}ms`);
        },
    };
}
