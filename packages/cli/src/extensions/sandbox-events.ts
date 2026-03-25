import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import {
    isSandboxActive,
    getSandboxMode,
    getViolations,
    clearViolations,
    onViolation,
    getResolvedConfig,
    type ViolationRecord,
} from "@pizzapi/tools";

/**
 * Sandbox events extension.
 *
 * - Registers `/sandbox` command with subcommands: status, violations, config
 * - Subscribes to violation events and emits them as pi events
 * - Emits a `sandbox:status_report` on session_start
 */
export const sandboxEventsExtension: ExtensionFactory = (pi) => {
    // ── Violation event forwarding ────────────────────────────────────────
    const unsubscribe = onViolation((violation: ViolationRecord) => {
        pi.events?.emit?.("sandbox:violation", {
            timestamp: violation.timestamp.toISOString(),
            operation: violation.operation,
            target: violation.target,
            reason: violation.reason,
            mode: getSandboxMode(),
        });
    });

    // ── Session start: emit status report ─────────────────────────────────
    pi.on("session_start", () => {
        const mode = getSandboxMode();
        if (mode === "none") return;

        pi.events?.emit?.("sandbox:status_report", {
            type: "sandbox_status",
            mode,          // "none" | "basic" | "full"
            active: isSandboxActive(),
            platform: process.platform,
            violations: getViolations().length,
            ts: Date.now(),
        });
    });

    // ── /sandbox slash command ─────────────────────────────────────────────
    pi.registerCommand?.("sandbox", {
        description: "Show sandbox status, violations, and config. Subcommands: status (default), violations, config",
        handler: async (_args: string, ctx: any) => {
            const subcommand = (_args ?? "").trim().split(/\s+/)[0] || "status";

            let output: string;
            if (subcommand === "violations") {
                output = formatViolations();
            } else if (subcommand === "config") {
                output = formatConfig();
            } else {
                output = formatStatus();
            }

            ctx?.ui?.notify?.(output);
        },
    });

    // ── Cleanup on shutdown ───────────────────────────────────────────────
    pi.on?.("session_shutdown", () => {
        unsubscribe();
    });
};

// ── Formatters ────────────────────────────────────────────────────────────────

// ANSI helpers — only active when stdout is a TTY (not in RPC/headless mode).
const isTTY = process.stdout.isTTY === true;
const ansi = (code: string, s: string, reset: string) => isTTY ? `\x1b[${code}m${s}\x1b[${reset}m` : s;
const green  = (s: string) => ansi("32", s, "39");
const yellow = (s: string) => ansi("33", s, "39");
const red    = (s: string) => ansi("31", s, "39");
const dim    = (s: string) => ansi("2",  s, "22");

function formatStatus(): string {
    const mode = getSandboxMode();
    const active = isSandboxActive();
    const violations = getViolations();
    const last5 = violations.slice(-5);

    const modeStr = mode === "full" ? green(mode) : mode === "basic" ? yellow(mode) : dim(mode);
    const violationStr = violations.length > 0 ? yellow(String(violations.length)) : green(String(violations.length));

    const lines: string[] = [
        `## 🔒 Sandbox Status`,
        ``,
        `- **Mode:** ${modeStr}`,
        `- **Active:** ${active ? green("✅ yes") : red("❌ no")}`,
        `- **Platform:** ${process.platform}`,
        `- **Violations:** ${violationStr}`,
    ];

    if (last5.length > 0) {
        lines.push("", "### Recent Violations", "");
        for (const v of last5) {
            const icon = v.operation === "read" ? "📖" : v.operation === "write" ? "✏️" : "⚡";
            const opStr = v.operation === "write" ? red(`\`${v.operation}\``) : yellow(`\`${v.operation}\``);
            lines.push(`- ${icon} ${opStr} → \`${v.target}\` ${dim(`— ${v.reason}`)}`);
        }
    }

    return lines.join("\n");
}

function formatViolations(): string {
    const violations = getViolations();

    if (violations.length === 0) {
        return green("✓ No sandbox violations recorded.");
    }

    const lines: string[] = [
        `## ${yellow(`Sandbox Violations (${violations.length})`)}`,
        "",
    ];

    for (const v of violations) {
        const ts = v.timestamp.toISOString();
        const opStr = v.operation === "write" ? red(`\`${v.operation}\``) : yellow(`\`${v.operation}\``);
        lines.push(
            `- ${dim(ts)} | ${opStr} | \`${v.target}\` ${dim(`| ${v.reason}`)}`,
        );
    }

    return lines.join("\n");
}

function formatConfig(): string {
    const config = getResolvedConfig();

    if (!config) {
        return "Sandbox has not been initialized.";
    }

    const lines: string[] = [
        "## Sandbox Config",
        "",
        "```json",
        JSON.stringify(config, null, 2),
        "```",
    ];

    return lines.join("\n");
}
