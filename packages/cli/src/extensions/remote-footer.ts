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
                const contextPercent = contextUsage?.percent ?? null;
                const contextPart =
                    contextPercent === null
                        ? `?/${formatTokens(contextWindow)} (auto)`
                        : `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;

                // Context usage color gradient
                const contextColor: "dim" | "warning" | "error" | null =
                    contextPercent === null || contextPercent < 50
                        ? "dim"
                        : contextPercent < 70
                        ? null // default text color — no wrapper
                        : contextPercent < 90
                        ? "warning"
                        : "error";

                let pwd = activeCtx.cwd;
                const home = homedir();
                if (home && pwd.startsWith(home)) {
                    pwd = `~${pwd.slice(home.length)}`;
                }

                // Git branch with ⎇ symbol
                const branch = footerData.getGitBranch();
                const branchSuffix = branch ? ` ⎇ ${branch}` : "";
                if (branchSuffix) pwd = `${pwd}${branchSuffix}`;

                // Session name — tracked separately so we can accent-color it after layout
                const sessionName = activeCtx.sessionManager.getSessionName();
                const sessionSuffix = sessionName ? ` • ${sessionName}` : "";
                if (sessionSuffix) pwd = `${pwd}${sessionSuffix}`;

                // Stats — context part tracked separately for gradient coloring
                const statsParts: string[] = [];
                if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
                if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
                if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
                if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
                if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);
                const statsWithoutContext = statsParts.join(" ");
                const statsText = statsWithoutContext ? `${statsWithoutContext} ${contextPart}` : contextPart;

                // Model badge — track provider separately for accent coloring
                const thinkingLevel = rctx.getCurrentThinkingLevel();
                const modelId = activeCtx.model?.id ?? "no-model";
                const modelDisplayName =
                    activeCtx.model?.reasoning && thinkingLevel
                        ? thinkingLevel === "off"
                            ? `${modelId} • thinking off`
                            : `${modelId} • ${thinkingLevel}`
                        : modelId;

                const providerName =
                    footerData.getAvailableProviderCount() > 1 && activeCtx.model
                        ? activeCtx.model.provider
                        : null;
                const modelTextPlain = providerName
                    ? `(${providerName}) ${modelDisplayName}`
                    : modelDisplayName;

                // Append auth source so the user knows where their API key is coming from
                const currentAuthSource = getAuthSource(activeCtx);
                const currentAuthLabel = authSourceLabel(currentAuthSource);
                const authSuffix = currentAuthLabel ? ` • ${currentAuthLabel}` : "";
                const modelBadge = `• ${modelTextPlain}${authSuffix}`;

                // Read relay status directly from the context object.
                const relayStatus = sanitizeStatusText(rctx.relayStatusText);
                const statusLower = relayStatus.toLowerCase();
                const relayStatusColor: "success" | "warning" | "error" =
                    statusLower.includes("disconnected") ||
                    statusLower.includes("not configured") ||
                    statusLower.includes("failed") ||
                    statusLower.includes("error")
                        ? "error"
                        : statusLower.includes("reconnecting") || statusLower.includes("connecting")
                        ? "warning"
                        : "success";

                // Layout (plain-text widths)
                const locationLine = layoutLeftRight(pwd, modelBadge, width, truncateMiddle);
                const statsLine = layoutLeftRight(statsText, relayStatus, width, truncateEnd);

                // ── Colored line 1 ──────────────────────────────────────────
                // Left: session name (if still present after truncation) in accent, rest dim
                let line1Left: string;
                if (sessionSuffix && locationLine.left.endsWith(sessionSuffix)) {
                    const base = locationLine.left.slice(0, locationLine.left.length - sessionSuffix.length);
                    line1Left = theme.fg("dim", base) + theme.fg("accent", sessionSuffix);
                } else {
                    line1Left = theme.fg("dim", locationLine.left);
                }

                // Right: provider in accent, model name in muted
                let line1Right: string;
                if (providerName) {
                    const providerTag = `(${providerName})`;
                    const providerIdx = locationLine.right.indexOf(providerTag);
                    if (providerIdx !== -1) {
                        const before = locationLine.right.slice(0, providerIdx);
                        const after = locationLine.right.slice(providerIdx + providerTag.length);
                        line1Right =
                            theme.fg("muted", before) +
                            theme.fg("accent", providerTag) +
                            theme.fg("muted", after);
                    } else {
                        line1Right = theme.fg("muted", locationLine.right);
                    }
                } else {
                    line1Right = theme.fg("muted", locationLine.right);
                }

                // ── Colored line 2 ──────────────────────────────────────────
                // Left: context part gets gradient color, surrounding stats get dim
                let line2Left: string;
                const contextInLeft = statsLine.left.lastIndexOf(contextPart);
                if (contextInLeft !== -1) {
                    const beforeCtx = statsLine.left.slice(0, contextInLeft);
                    const ctxStr = statsLine.left.slice(contextInLeft);
                    const coloredCtx = contextColor ? theme.fg(contextColor, ctxStr) : ctxStr;
                    line2Left = theme.fg("dim", beforeCtx) + coloredCtx;
                } else {
                    line2Left = theme.fg("dim", statsLine.left);
                }

                const line2Right = theme.fg(relayStatusColor, statsLine.right);

                // Padding (based on plain-text lengths)
                const line1Raw = locationLine.left + locationLine.pad + locationLine.right;
                const line2Raw = statsLine.left + statsLine.pad + statsLine.right;
                const line1Pad = " ".repeat(Math.max(0, width - line1Raw.length));
                const line2Pad = " ".repeat(Math.max(0, width - line2Raw.length));

                return [
                    line1Left + locationLine.pad + line1Right + line1Pad,
                    line2Left + statsLine.pad + line2Right + line2Pad,
                ];
            },
        };
    });
}
