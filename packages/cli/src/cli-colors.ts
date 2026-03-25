/**
 * CLI color utilities for PizzaPi — "Warm Confidence" palette.
 *
 * Respects NO_COLOR env var and non-TTY output (pipes, redirects).
 * All helpers are no-ops when color is disabled, so --json and piped
 * output are never polluted with escape sequences.
 */

const isColorEnabled =
    process.stdout.isTTY === true &&
    !("NO_COLOR" in process.env) &&
    process.env["TERM"] !== "dumb";

const esc = (code: string, s: string, reset: string) =>
    isColorEnabled ? `\x1b[${code}m${s}\x1b[${reset}m` : s;

export const c = {
    /** Bold bright plum — pizza logo / product name */
    brand: (s: string) => esc("1;35", s, "0"),

    /** Bold bright magenta — command names */
    cmd: (s: string) => esc("1;35", s, "0"),

    /** Light purple — section headers ("Commands", "Flags") */
    label: (s: string) => (isColorEnabled ? `\x1b[38;2;196;167;224m${s}\x1b[39m` : s),

    /** Soft lavender — accent / highlight */
    accent: (s: string) => (isColorEnabled ? `\x1b[38;2;232;180;248m${s}\x1b[39m` : s),

    /** Light blue — flag names */
    flag: (s: string) => (isColorEnabled ? `\x1b[38;2;147;197;253m${s}\x1b[39m` : s),

    /** Green — success / ok */
    success: (s: string) => esc("32", s, "39"),

    /** Red — error / failure */
    error: (s: string) => esc("31", s, "39"),

    /** Amber/yellow — warning / moderate usage */
    warning: (s: string) => esc("33", s, "39"),

    /** Bold */
    bold: (s: string) => esc("1", s, "22"),

    /** Dim gray — secondary info */
    dim: (s: string) => esc("2", s, "22"),

    /** Reset all attributes */
    reset: isColorEnabled ? "\x1b[0m" : "",
};

/**
 * Return a colored usage bar + percentage string.
 *
 * @param utilization  0–100 (percentage used)
 * @param width        bar width in characters (default 10)
 */
export function usageBar(utilization: number, width = 10): string {
    const pct = Math.min(100, Math.max(0, utilization));
    const filled = Math.round((pct / 100) * width);
    const empty = width - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);
    const pctStr = `${pct.toFixed(1)}%`;

    if (!isColorEnabled) return `[${bar}] ${pctStr}`;

    let colored: string;
    if (pct < 50) {
        colored = `\x1b[32m${bar}\x1b[39m`;
    } else if (pct <= 80) {
        colored = `\x1b[33m${bar}\x1b[39m`;
    } else {
        colored = `\x1b[31m${bar}\x1b[39m`;
    }

    let pctColored: string;
    if (pct < 50) {
        pctColored = `\x1b[32m${pctStr}\x1b[39m`;
    } else if (pct <= 80) {
        pctColored = `\x1b[33m${pctStr}\x1b[39m`;
    } else {
        pctColored = `\x1b[31m${pctStr}\x1b[39m`;
    }

    return `[${colored}] ${pctColored}`;
}

/**
 * Return a colored percentage string without a bar.
 * Green <50%, amber 50-80%, red ≥80%.
 */
export function colorPct(pct: number): string {
    const s = `${pct.toFixed(1)}%`;
    if (!isColorEnabled) return s;
    if (pct < 50) return `\x1b[32m${s}\x1b[39m`;
    if (pct <= 80) return `\x1b[33m${s}\x1b[39m`;
    return `\x1b[31m${s}\x1b[39m`;
}

/**
 * Return a colored remaining-percentage string.
 * Coloring is based on remaining (high remaining = green, low remaining = red):
 * Green >50%, amber 20-50%, red ≤20%.
 */
export function colorRemaining(pct: number): string {
    const s = `${pct.toFixed(1)}%`;
    if (!isColorEnabled) return s;
    if (pct > 50) return `\x1b[32m${s}\x1b[39m`;
    if (pct > 20) return `\x1b[33m${s}\x1b[39m`;
    return `\x1b[31m${s}\x1b[39m`;
}
