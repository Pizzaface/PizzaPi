/**
 * Programmatic isolation of the claude-subscription "out of extra usage /
 * org_level_disabled" failure. Fires a small matrix of /v1/messages requests
 * with the SAME Claude Code OAuth token, varying one axis at a time, and reports
 * HTTP status + the `anthropic-ratelimit-unified-overage-disabled-reason` header.
 *
 * Run: cd packages/cli && bun scripts/probe-overage.ts
 *
 * Uses tiny max_tokens and spaces requests to limit quota use / avoid 429s.
 */

import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const BASE_BETA = "oauth-2025-04-20,claude-code-20250219";
const INTERLEAVED = ",interleaved-thinking-2025-05-14";
const FALLBACK_BETA = ",server-side-fallback-2026-06-01";

function fp(t: string): string { return `…${t.slice(-6)}(len=${t.length})`; }

// Token the extension actually uses: Claude Code Keychain credential.
function keychainToken(): string | null {
    try {
        const raw = execSync(`security find-generic-password -s ${JSON.stringify("Claude Code-credentials")} -w`, { encoding: "utf-8" }).trim();
        return JSON.parse(raw)?.claudeAiOauth?.accessToken ?? null;
    } catch { return null; }
}

const authToken = await AuthStorage.create(join(homedir(), ".pizzapi", "auth.json")).getApiKey("anthropic");
const kcToken = keychainToken();
console.log(`pizzapi auth.json token: ${authToken ? fp(authToken) : "(none)"}`);
console.log(`keychain CC token:       ${kcToken ? fp(kcToken) : "(none)"}`);
console.log(`same token? ${authToken === kcToken}\n`);
const token = kcToken ?? authToken; // extension uses the Keychain token
if (!token) { console.error("no anthropic token"); process.exit(1); }

const bigSystem = "You are a coding assistant.\n".repeat(2300); // ~63k chars
const smallSystem = "You are a coding assistant.";
const manyTools = Array.from({ length: 58 }, (_, i) => ({
    name: i < 4 ? ["read", "bash", "edit", "write"][i] : `tool_${i}`,
    description: "x",
    input_schema: { type: "object", properties: { a: { type: "string" } } },
}));
const fewTools = manyTools.slice(0, 4);

type Case = {
    label: string;
    model: string;
    system: string;
    tools: unknown[];
    beta: string;
    thinking?: unknown;
    output_config?: unknown;
    fallbacks?: unknown;
    max_tokens: number;
};

// A = working replica (raw pi / fable). B = failing replica (pizza / opus budget).
// Then mutate B→A one axis at a time.
const cases: Case[] = [
    { label: "A  working replica: fable-5, small sys, 4 tools, adaptive (stream)",
      model: "claude-fable-5", system: smallSystem, tools: fewTools, beta: BASE_BETA + FALLBACK_BETA,
      thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" },
      fallbacks: [{ model: "claude-opus-4-8" }], max_tokens: 128000 },

    { label: "B  failing replica: opus-4-6, BIG sys, 58 tools, budget thinking (stream)",
      model: "claude-opus-4-6", system: bigSystem, tools: manyTools, beta: BASE_BETA + INTERLEAVED,
      thinking: { type: "enabled", budget_tokens: 20480 }, max_tokens: 128000 },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const c of cases) {
    const body: Record<string, unknown> = {
        model: c.model,
        max_tokens: c.max_tokens,
        system: [{ type: "text", text: IDENTITY }, { type: "text", text: c.system }],
        messages: [{ role: "user", content: "say hi in one word" }],
        tools: c.tools,
        stream: true,
    };
    if (c.thinking) body.thinking = c.thinking;
    if (c.output_config) body.output_config = c.output_config;
    if (c.fallbacks) body.fallbacks = c.fallbacks;

    let status = 0, reason = "", errMsg = "";
    for (let attempt = 0; attempt < 5; attempt++) {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "anthropic-version": "2023-06-01",
                "anthropic-beta": c.beta,
            },
            body: JSON.stringify(body),
        });
        status = res.status;
        reason = res.headers.get("anthropic-ratelimit-unified-overage-disabled-reason") ?? "";
        if (status === 429) { await sleep(12000); continue; }
        // stream:true returns 200 then may error mid-stream — must read the body.
        errMsg = await res.text();
        break;
    }
    console.log(`\n===== ${c.label} =====`);
    console.log(`HTTP ${status}  overage-header=${reason || "-"}`);
    console.log(`--- full response body ---`);
    console.log(errMsg);
    console.log(`--- end ---`);
    await sleep(6000);
}
