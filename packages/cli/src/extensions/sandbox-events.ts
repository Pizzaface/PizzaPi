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

function formatStatus(): string {
    const mode = getSandboxMode();
    const active = isSandboxActive();
    const violations = getViolations();
    const last5 = violations.slice(-5);

    const modeColor = mode === "full" ? "\x1b[32m" : mode === "basic" ? "\x1b[33m" : "\x1b[2m";
    const violationCount = violations.length > 0
        ? `\x1b[33m${violations.length}\x1b[0m`
        : `\x1b[32m${violations.length}\x1b[0m`;

    const lines: string[] = [
        `## 🔒 Sandbox Status`,
        ``,
        `- **Mode:** ${modeColor}${mode}\x1b[0m`,
        `- **Active:** ${active ? "\x1b[32m✅ yes\x1b[0m" : "\x1b[31m❌ no\x1b[0m"}`,
        `- **Platform:** ${process.platform}`,
        `- **Violations:** ${violationCount}`,
    ];

    if (last5.length > 0) {
        lines.push("", "### Recent Violations", "");
        for (const v of last5) {
            const icon = v.operation === "read" ? "📖" : v.operation === "write" ? "✏️" : "⚡";
            const opColor = v.operation === "write" ? "\x1b[31m" : "\x1b[33m";
            lines.push(`- ${icon} ${opColor}\`${v.operation}\`\x1b[0m → \`${v.target}\` \x1b[2m— ${v.reason}\x1b[0m`);
        }
    }

    return lines.join("\n");
}

function formatViolations(): string {
    const violations = getViolations();

    if (violations.length === 0) {
        return "\x1b[32m✓ No sandbox violations recorded.\x1b[0m";
    }

    const lines: string[] = [
        `## \x1b[33mSandbox Violations (${violations.length})\x1b[0m`,
        "",
    ];

    for (const v of violations) {
        const ts = v.timestamp.toISOString();
        const opColor = v.operation === "write" ? "\x1b[31m" : "\x1b[33m";
        lines.push(
            `- \x1b[2m${ts}\x1b[0m | ${opColor}\`${v.operation}\`\x1b[0m | \`${v.target}\` \x1b[2m| ${v.reason}\x1b[0m`,
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
