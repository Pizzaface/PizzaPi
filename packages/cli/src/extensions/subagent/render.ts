/**
 * TUI rendering functions for the subagent tool.
 *
 * Provides renderSubagentCall and renderSubagentResult — extracted from the
 * pi.registerTool({ renderCall, renderResult }) inline methods so they can be
 * tested and reused independently.
 */

import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import type { SubagentDetails } from "./types.js";
import { COLLAPSED_ITEM_COUNT, getFinalOutput, getDisplayItems } from "./types.js";
import { formatToolCall, formatUsageStats, aggregateUsage } from "./format.js";

// ── Call rendering ─────────────────────────────────────────────────────

export function renderSubagentCall(args: any, theme: any): any {
    const scope = args.agentScope ?? "user";
    if (args.chain && args.chain.length > 0) {
        let text =
            theme.fg("accent", "◈ ") + theme.fg("toolTitle", theme.bold("subagent")) + " " +
            theme.fg("accent", `chain (${args.chain.length} steps)`) +
            theme.fg("muted", ` [${scope}]`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
            const step = args.chain[i];
            const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
            const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
            text +=
                "\n  " +
                theme.fg("muted", `${i + 1}.`) + " " +
                theme.fg("accent", step.agent) +
                theme.fg("dim", ` ${preview}`);
        }
        if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
    }
    if (args.tasks && args.tasks.length > 0) {
        let text =
            theme.fg("accent", "◈ ") + theme.fg("toolTitle", theme.bold("subagent")) + " " +
            theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
            theme.fg("muted", ` [${scope}]`);
        for (const t of args.tasks.slice(0, 3)) {
            const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
            text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
    }
    const agentName = args.agent || "...";
    const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
    let text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", agentName) +
        theme.fg("muted", ` [${scope}]`);
    text += `\n  ${theme.fg("dim", preview)}`;
    return new Text(text, 0, 0);
}

// ── Result rendering ───────────────────────────────────────────────────

export function renderSubagentResult(result: any, opts: { expanded: boolean }, theme: any): any {
    const { expanded } = opts;
    const details = result.details as SubagentDetails | undefined;
    if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
    }

    const mdTheme = getMarkdownTheme();

    const renderDisplayItems = (items: ReturnType<typeof getDisplayItems>, limit?: number) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped = limit && items.length > limit ? items.length - limit : 0;
        let text = "";
        if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
        for (const item of toShow) {
            if (item.type === "text") {
                const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
                text += `${theme.fg("toolOutput", preview)}\n`;
            } else {
                text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
            }
        }
        return text.trimEnd();
    };

    // ── Single result rendering ────────────────────────────────────────
    if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0];
        const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const displayItems = getDisplayItems(r.messages);
        const finalOutput = getFinalOutput(r.messages);

        if (expanded) {
            const container = new Container();
            let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
            if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
            container.addChild(new Text(header, 0, 0));
            if (isError && r.errorMessage)
                container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("border", "─── Task ───"), 0, 0));
            container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("border", "─── Output ───"), 0, 0));
            if (displayItems.length === 0 && !finalOutput) {
                container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
            } else {
                for (const item of displayItems) {
                    if (item.type === "toolCall")
                        container.addChild(
                            new Text(
                                theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                                0, 0,
                            ),
                        );
                }
                if (finalOutput) {
                    container.addChild(new Spacer(1));
                    container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
                }
            }
            const usageStr = formatUsageStats(r.usage, r.model);
            if (usageStr) {
                container.addChild(new Spacer(1));
                container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
            }
            return container;
        }

        // Collapsed single view
        let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
        if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
        if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
        else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
        else {
            text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
            if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        }
        const usageStr = formatUsageStats(r.usage, r.model);
        if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
        return new Text(text, 0, 0);
    }

    // ── Chain result rendering ─────────────────────────────────────────
    if (details.mode === "chain") {
        const successCount = details.results.filter((r) => r.exitCode === 0).length;
        const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

        if (expanded) {
            const container = new Container();
            container.addChild(
                new Text(
                    icon + " " +
                    theme.fg("toolTitle", theme.bold("chain ")) +
                    theme.fg("accent", `${successCount}/${details.results.length} steps`),
                    0, 0,
                ),
            );

            for (const r of details.results) {
                const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
                const displayItems = getDisplayItems(r.messages);
                const finalOutput = getFinalOutput(r.messages);

                container.addChild(new Spacer(1));
                container.addChild(
                    new Text(theme.fg("border", "─── ") + theme.fg("muted", "Step ") + theme.fg("accent", `${r.step}: `) + theme.fg("accent", r.agent) + " " + rIcon, 0, 0),
                );
                container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

                for (const item of displayItems) {
                    if (item.type === "toolCall") {
                        container.addChild(
                            new Text(
                                theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                                0, 0,
                            ),
                        );
                    }
                }

                if (finalOutput) {
                    container.addChild(new Spacer(1));
                    container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
                }

                const stepUsage = formatUsageStats(r.usage, r.model);
                if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
            }

            const usageStr = formatUsageStats(aggregateUsage(details.results));
            if (usageStr) {
                container.addChild(new Spacer(1));
                container.addChild(new Text(theme.fg("muted", "Total: ") + theme.fg("dim", usageStr), 0, 0));
            }
            return container;
        }

        // Collapsed chain view
        let text =
            icon + " " +
            theme.fg("toolTitle", theme.bold("chain ")) +
            theme.fg("accent", `${successCount}/${details.results.length} steps`);
        for (const r of details.results) {
            const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
            const displayItems = getDisplayItems(r.messages);
            text += `\n\n${theme.fg("border", "─── ")}${theme.fg("muted", "Step ")}${theme.fg("accent", `${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
            if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
            else text += `\n${renderDisplayItems(displayItems, 5)}`;
        }
        const usageStr = formatUsageStats(aggregateUsage(details.results));
        if (usageStr) text += `\n\n${theme.fg("muted", "Total: ")}${theme.fg("dim", usageStr)}`;
        text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
    }

    // ── Parallel result rendering ──────────────────────────────────────
    if (details.mode === "parallel") {
        const running = details.results.filter((r) => r.exitCode === -1).length;
        const successCount = details.results.filter((r) => r.exitCode === 0).length;
        const failCount = details.results.filter((r) => r.exitCode > 0).length;
        const isRunning = running > 0;
        const icon = isRunning
            ? theme.fg("warning", "⏳")
            : failCount > 0
                ? theme.fg("warning", "◐")
                : theme.fg("success", "✓");
        const status = isRunning
            ? `${successCount + failCount}/${details.results.length} done, ${running} running`
            : `${successCount}/${details.results.length} tasks`;

        if (expanded && !isRunning) {
            const container = new Container();
            container.addChild(
                new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0),
            );

            for (const r of details.results) {
                const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
                const displayItems = getDisplayItems(r.messages);
                const finalOutput = getFinalOutput(r.messages);

                container.addChild(new Spacer(1));
                container.addChild(
                    new Text(theme.fg("border", "─── ") + theme.fg("accent", r.agent) + " " + rIcon, 0, 0),
                );
                container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

                for (const item of displayItems) {
                    if (item.type === "toolCall") {
                        container.addChild(
                            new Text(
                                theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                                0, 0,
                            ),
                        );
                    }
                }

                if (finalOutput) {
                    container.addChild(new Spacer(1));
                    container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
                }

                const taskUsage = formatUsageStats(r.usage, r.model);
                if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
            }

            const usageStr = formatUsageStats(aggregateUsage(details.results));
            if (usageStr) {
                container.addChild(new Spacer(1));
                container.addChild(new Text(theme.fg("muted", "Total: ") + theme.fg("dim", usageStr), 0, 0));
            }
            return container;
        }

        // Collapsed parallel view (or still running)
        let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
        for (const r of details.results) {
            const rIcon =
                r.exitCode === -1
                    ? theme.fg("warning", "⏳")
                    : r.exitCode === 0
                        ? theme.fg("success", "✓")
                        : theme.fg("error", "✗");
            const displayItems = getDisplayItems(r.messages);
            text += `\n\n${theme.fg("border", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
            if (displayItems.length === 0)
                text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
            else text += `\n${renderDisplayItems(displayItems, 5)}`;
        }
        if (!isRunning) {
            const usageStr = formatUsageStats(aggregateUsage(details.results));
            if (usageStr) text += `\n\n${theme.fg("muted", "Total: ")}${theme.fg("dim", usageStr)}`;
        }
        if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
    }

    // Fallback
    const text = result.content[0];
    return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
}
