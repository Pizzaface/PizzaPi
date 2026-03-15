/**
 * TUI footer rendering for the remote extension.
 *
 * Contains pure layout/format utilities and the footer installer that reads
 * from RelayContext.
 */

import { homedir } from "node:os";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RelayContext } from "./remote-types.js";
import { getAuthSource, authSourceLabel } from "./remote-auth-source.js";

// ── Pure utilities ───────────────────────────────────────────────────────────

export function sanitizeStatusText(text: string): string {
    return text
        .replace(/\x1B\[[0-9;]*m/g, "")
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
}

export function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}

export function truncateEnd(text: string, width: number): string {
    if (width <= 0) return "";
    if (text.length <= width) return text;
    if (width <= 3) return text.slice(0, width);
    return `${text.slice(0, width - 3)}...`;
}

export function truncateMiddle(text: string, width: number): string {
    if (width <= 0) return "";
    if (text.length <= width) return text;
    if (width <= 5) return truncateEnd(text, width);
    const half = Math.floor((width - 3) / 2);
    const start = text.slice(0, half);
    const end = text.slice(-(width - 3 - half));
    return `${start}...${end}`;
}

export function layoutLeftRight(
    left: string,
    right: string,
    width: number,
    truncateLeft: (text: string, width: number) => string,
): { left: string; pad: string; right: string } {
    if (width <= 0) return { left: "", pad: "", right: "" };
    const safeRight = truncateEnd(right, width);
    if (!safeRight) return { left: truncateLeft(left, width), pad: "", right: "" };
    if (safeRight.length + 2 >= width) return { left: "", pad: "", right: safeRight };

    const leftWidth = width - safeRight.length - 2;
    const safeLeft = truncateLeft(left, leftWidth);
    const pad = " ".repeat(Math.max(width - safeLeft.length - safeRight.length, 2));
    return { left: safeLeft, pad, right: safeRight };
}

// ── Footer installer ─────────────────────────────────────────────────────────

export function installFooter(rctx: RelayContext, ctx: ExtensionContext) {
    ctx.ui.setFooter((tui, theme, footerData) => {
        const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

        return {
            dispose: unsubscribe,
            invalidate() {},
            render(width: number): string[] {
                const activeCtx = rctx.latestCtx ?? ctx;

                let totalInput = 0;
                let totalOutput = 0;
                let totalCacheRead = 0;
                let totalCacheWrite = 0;
                let totalCost = 0;
                for (const entry of activeCtx.sessionManager.getEntries()) {
                    if (entry.type === "message" && entry.message.role === "assistant") {
                        totalInput += entry.message.usage.input;
                        totalOutput += entry.message.usage.output;
                        totalCacheRead += entry.message.usage.cacheRead;
                        totalCacheWrite += entry.message.usage.cacheWrite;
                        totalCost += entry.message.usage.cost.total;
                    }
                }

                const contextUsage = activeCtx.getContextUsage();
                const contextWindow = contextUsage?.contextWindow ?? activeCtx.model?.contextWindow ?? 0;
                const contextPart =
                    contextUsage?.percent === null
                        ? `?/${formatTokens(contextWindow)} (auto)`
                        : `${(contextUsage?.percent ?? 0).toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;

                let pwd = activeCtx.cwd;
                const home = homedir();
                if (home && pwd.startsWith(home)) {
                    pwd = `~${pwd.slice(home.length)}`;
                }

                const branch = footerData.getGitBranch();
                if (branch) {
                    pwd = `${pwd} (${branch})`;
                }

                const sessionName = activeCtx.sessionManager.getSessionName();
                if (sessionName) {
                    pwd = `${pwd} • ${sessionName}`;
                }

                const statsParts: string[] = [];
                if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
                if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
                if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
                if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
                if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);
                statsParts.push(contextPart);

                const thinkingLevel = rctx.getCurrentThinkingLevel();
                const modelName = activeCtx.model?.id ?? "no-model";
                let modelText =
                    activeCtx.model?.reasoning && thinkingLevel
                        ? thinkingLevel === "off"
                            ? `${modelName} • thinking off`
                            : `${modelName} • ${thinkingLevel}`
                        : modelName;

                if (footerData.getAvailableProviderCount() > 1 && activeCtx.model) {
                    modelText = `(${activeCtx.model.provider}) ${modelText}`;
                }

                // Append auth source so the user knows where their API key is coming from
                const currentAuthSource = getAuthSource(activeCtx);
                const currentAuthLabel = authSourceLabel(currentAuthSource);
                if (currentAuthLabel) {
                    modelText += ` • ${currentAuthLabel}`;
                }

                // Read relay status directly from the context object.
                const relayStatus = sanitizeStatusText(rctx.relayStatusText);

                const statsText = statsParts.join(" ");
                const modelBadge = `• ${modelText}`;
                const locationLine = layoutLeftRight(pwd, modelBadge, width, truncateMiddle);
                const statsLine = layoutLeftRight(statsText, relayStatus, width, truncateEnd);
                const statusLower = relayStatus.toLowerCase();
                const relayStatusColor =
                    statusLower.includes("disconnected") || statusLower.includes("not configured") ||
                    statusLower.includes("failed") || statusLower.includes("error")
                        ? "error"
                        : "success";

                const line1Raw = locationLine.left + locationLine.pad + locationLine.right;
                const line2Raw = statsLine.left + statsLine.pad + statsLine.right;

                const line1Pad = " ".repeat(Math.max(0, width - line1Raw.length));
                const line2Pad = " ".repeat(Math.max(0, width - line2Raw.length));

                return [
                    theme.fg("dim", locationLine.left) + locationLine.pad + theme.fg("dim", locationLine.right) + line1Pad,
                    theme.fg("dim", statsLine.left) + statsLine.pad + theme.fg(relayStatusColor as any, statsLine.right) + line2Pad,
                ];
            },
        };
    });
}
