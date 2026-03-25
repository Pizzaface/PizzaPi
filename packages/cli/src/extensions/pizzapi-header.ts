/**
 * PizzaPi branded TUI header with box-drawing frame.
 *
 * Replaces pi's built-in header with a "balanced control panel" layout:
 * a box-drawing frame containing the PizzaPi title centered in the top border
 * and keybinding hints organised by category.
 *
 * For narrow terminals (< 80 cols), falls back to a compact text-only header.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── Version ──────────────────────────────────────────────────────────────────

function getPizzaPiVersion(): string {
    try {
        const require = createRequire(import.meta.url);
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        // Works whether running from src/ or dist/
        const pkgPath = join(__dirname, "..", "..", "package.json");
        const pkg = require(pkgPath) as { version: string };
        return pkg.version ?? "0.0.0";
    } catch {
        return "0.0.0";
    }
}

// ── Default keybinding display strings ───────────────────────────────────────
// These mirror DEFAULT_APP_KEYBINDINGS from pi-coding-agent/dist/core/keybindings.js
// Since extensions don't receive a KeybindingsManager, we hardcode defaults here.

const KEYS = {
    interrupt: "Esc",
    clear: "Ctrl+C",
    exit: "Ctrl+D",
    suspend: "Ctrl+Z",
    cycleThinkingLevel: "⇧Tab",
    cycleModelForward: "Ctrl+P",
    cycleModelBackward: "⇧Ctrl+P",
    selectModel: "Ctrl+L",
    expandTools: "Ctrl+O",
    toggleThinking: "Ctrl+T",
    externalEditor: "Ctrl+G",
    followUp: "Alt+↩",
    dequeue: "Alt+↑",
    pasteImage: "Ctrl+V",
} as const;

// ── Layout helpers ────────────────────────────────────────────────────────────

/** Pad a string (which may contain ANSI codes) to exactly `width` visible chars. */
function padToWidth(s: string, width: number): string {
    const vis = visibleWidth(s);
    if (vis >= width) return s;
    return s + " ".repeat(width - vis);
}

/**
 * Build a hint segment: styled key + styled description.
 * key in "muted", description in "dim".
 */
function hint(
    theme: Theme,
    key: string,
    desc: string,
): { text: string; rawLen: number } {
    const raw = `${key} ${desc}`;
    const text = theme.fg("muted", key) + theme.fg("dim", ` ${desc}`);
    return { text, rawLen: raw.length };
}

/**
 * Join hint segments with a " · " separator, truncating to fit `innerWidth`.
 * Returns the composed line (may contain ANSI codes).
 */
function buildHintLine(
    theme: Theme,
    hints: Array<{ text: string; rawLen: number }>,
    innerWidth: number,
): string {
    const sep = " · ";
    const sepRaw = sep.length;
    const sepStyled = theme.fg("dim", sep);

    let line = "";
    let usedRaw = 0;

    for (let i = 0; i < hints.length; i++) {
        const h = hints[i]!;
        const addLen = (i === 0 ? 0 : sepRaw) + h.rawLen;
        if (usedRaw + addLen > innerWidth) break;
        if (i > 0) line += sepStyled;
        line += h.text;
        usedRaw += addLen;
    }
    return line;
}

/** Render a box content line: `│ <padded-content> │` */
function boxLine(
    theme: Theme,
    content: string,
    width: number,
): string {
    const innerWidth = width - 4; // 2 for "│ " prefix + 2 for " │" suffix
    const padded = padToWidth(content, Math.max(0, innerWidth));
    return theme.fg("border", "│") + " " + padded + " " + theme.fg("border", "│");
}

/** Build the top border: `╭──── 🍕 PizzaPi v0.4.0 ────╮` */
function topBorder(
    theme: Theme,
    version: string,
    width: number,
): string {
    const titleRaw = ` 🍕 PizzaPi v${version} `;
    // +2 for the corner chars; the title sits inside the horizontal rule
    const ruleWidth = width - 2;
    if (ruleWidth <= titleRaw.length) {
        // Too narrow: just horizontal rule
        return theme.fg("border", "╭" + "─".repeat(Math.max(0, ruleWidth)) + "╮");
    }
    const remaining = ruleWidth - titleRaw.length;
    const leftDashes = Math.floor(remaining / 2);
    const rightDashes = remaining - leftDashes;
    // Rebuild: corner + dashes + styled-title + dashes + corner
    return (
        theme.fg("border", "╭" + "─".repeat(leftDashes)) +
        theme.fg("accent", `🍕 PizzaPi v${version}`) +
        theme.fg("border", " " + "─".repeat(rightDashes) + "╮")
    );
}

/** Middle separator: `├──...──┤` */
function midBorder(
    theme: Theme,
    width: number,
): string {
    return theme.fg("border", "├" + "─".repeat(Math.max(0, width - 2)) + "┤");
}

/** Bottom border: `╰──...──╯` */
function bottomBorder(
    theme: Theme,
    width: number,
): string {
    return theme.fg("border", "╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
}

// ── Extension factory ─────────────────────────────────────────────────────────

/**
 * ExtensionFactory that installs the PizzaPi branded TUI header.
 *
 * Registers on "session_start" and calls ctx.ui.setHeader() to replace
 * pi's built-in header with the branded box-drawing frame.
 */
export function pizzapiHeaderExtension(pi: ExtensionAPI): void {
    const version = getPizzaPiVersion();

    pi.on("session_start", (_event, ctx) => {
        ctx.ui.setHeader((_tui, theme) => {
            return {
                invalidate() {},

                render(width: number): string[] {
                    const innerWidth = width - 4;

                    // ── Narrow fallback (< 100 cols) ─────────────────────────
                    if (width < 100) {
                        if (width <= 0) return [];

                        // Build title, truncating to fit within width
                        const titleRaw = `🍕 PizzaPi v${version}`;
                        let titleFit = "";
                        let titleFitWidth = 0;
                        for (const char of titleRaw) {
                            const cw = visibleWidth(char);
                            if (titleFitWidth + cw > width) break;
                            titleFit += char;
                            titleFitWidth += cw;
                        }

                        const titleStyled = theme.fg("accent", titleFit);

                        // Remaining space after title and 2-char separator ("  ")
                        const hintSpace = width - titleFitWidth - 2;
                        if (hintSpace <= 0) {
                            return [titleStyled];
                        }

                        const hintsLine = buildHintLine(theme, [
                            hint(theme, KEYS.clear, "clear"),
                            hint(theme, KEYS.exit, "exit"),
                            hint(theme, KEYS.suspend, "suspend"),
                        ], hintSpace);

                        return [hintsLine ? titleStyled + "  " + hintsLine : titleStyled];
                    }

                    // ── Wide layout with box-drawing frame ───────────────────

                    // Row 1 — basic controls
                    const row1 = buildHintLine(theme, [
                        hint(theme, KEYS.clear, "interrupt"),
                        hint(theme, KEYS.exit, "exit"),
                        hint(theme, KEYS.suspend, "suspend"),
                    ], innerWidth);

                    // Row 2 — thinking / model
                    const row2 = buildHintLine(theme, [
                        hint(theme, KEYS.cycleThinkingLevel, "thinking"),
                        hint(theme, KEYS.toggleThinking, "toggle thinking"),
                        hint(theme, `${KEYS.cycleModelForward}/${KEYS.cycleModelBackward}`, "cycle models"),
                        hint(theme, KEYS.selectModel, "select model"),
                    ], innerWidth);

                    // Row 3 — tools / nav
                    const row3 = buildHintLine(theme, [
                        hint(theme, KEYS.expandTools, "tools"),
                        hint(theme, KEYS.externalEditor, "editor"),
                        hint(theme, KEYS.followUp, "follow-up"),
                        hint(theme, KEYS.dequeue, "dequeue"),
                    ], innerWidth);

                    // Row 4 — special inputs
                    const row4 = buildHintLine(theme, [
                        hint(theme, "/", "commands"),
                        hint(theme, "!", "bash"),
                        hint(theme, "!!", "bash (no ctx)"),
                        hint(theme, KEYS.pasteImage, "paste"),
                        { text: theme.fg("dim", "drop files"), rawLen: "drop files".length },
                    ], innerWidth);

                    return [
                        topBorder(theme, version, width),
                        boxLine(theme, row1, width),
                        midBorder(theme, width),
                        boxLine(theme, row2, width),
                        boxLine(theme, row3, width),
                        boxLine(theme, row4, width),
                        bottomBorder(theme, width),
                    ];
                },
            };
        });
    });
}
