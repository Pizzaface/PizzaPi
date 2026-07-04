/**
 * Programmatic isolation of the claude-subscription "out of extra usage /
 * org_level_disabled" / 429 failure. Fires a small matrix of /v1/messages
 * requests with the SAME Claude Code OAuth token, varying ONE axis at a time
 * (tool count/shape vs system-prompt size), and reports HTTP status plus all
 * `anthropic-ratelimit-*` headers.
 *
 * Model + thinking are held constant at the known-good config (fable-5,
 * adaptive) so any status/header delta is attributable to the varied axis.
 *
 * Run: cd packages/cli && bun scripts/probe-overage.ts
 *
 * Caveat: overage-disable/429 discrimination is clearest when the plan is
 * near its quota window limit; far from the limit everything may return 200 —
 * the ratelimit headers are still worth comparing in that case.
 */

import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const BASE_BETA = "oauth-2025-04-20,claude-code-20250219";
const INTERLEAVED = ",interleaved-thinking-2025-05-14";
const FALLBACK_BETA = ",server-side-fallback-2026-06-01";

function fp(t: string): string { return `…${t.slice(-6)}(len=${t.length})`; }

// Token sources, in the same priority order the extension uses:
// 1. ${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json  2. macOS Keychain.
function fileToken(): { token: string; expiresAt: number } | null {
    try {
        const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
        const raw = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf-8"))?.claudeAiOauth;
        return raw?.accessToken ? { token: raw.accessToken, expiresAt: raw.expiresAt ?? 0 } : null;
    } catch { return null; }
}
function keychainToken(): { token: string; expiresAt: number } | null {
    try {
        const raw = execSync(`security find-generic-password -s ${JSON.stringify("Claude Code-credentials")} -w`, { encoding: "utf-8" }).trim();
        const cc = JSON.parse(raw)?.claudeAiOauth;
        return cc?.accessToken ? { token: cc.accessToken, expiresAt: cc.expiresAt ?? 0 } : null;
    } catch { return null; }
}

const authToken = await AuthStorage.create(join(homedir(), ".pizzapi", "auth.json")).getApiKey("anthropic");
const file = fileToken();
const kc = keychainToken();
const mins = (c: { expiresAt: number } | null) => c ? Math.round((c.expiresAt - Date.now()) / 60000) : null;
console.log(`pizzapi auth.json token:  ${authToken ? fp(authToken) : "(none)"}`);
console.log(`.credentials.json token:  ${file ? `${fp(file.token)} expires in ${mins(file)}min` : "(none)"}`);
console.log(`keychain CC token:        ${kc ? `${fp(kc.token)} expires in ${mins(kc)}min` : "(none)"}`);
const fresh = [file, kc].filter((c): c is NonNullable<typeof c> => !!c && c.expiresAt > Date.now() + 60000);
const token = fresh[0]?.token ?? authToken;
if (!token) { console.error("no unexpired anthropic token — log in with Claude Code first"); process.exit(1); }
console.log(`using: ${fp(token)}\n`);

const bigSystem = "You are a coding assistant.\n".repeat(2300); // ~63k chars
const smallSystem = "You are a coding assistant.";

// 26 builtin-shaped tools — mirrors what PizzaPi actually sends today (known
// to work on the subscription lane).
const BUILTIN_NAMES = [
    "read", "bash", "edit", "write", "tell_child", "respond_to_trigger",
    "fire_trigger", "escalate_trigger", "list_available_triggers",
    "list_available_sigils", "subscribe_trigger", "unsubscribe_trigger",
    "update_trigger_subscription", "AskUserQuestion", "plan_mode",
    "create_tunnel", "list_tunnels", "close_tunnel", "web_search", "web_fetch",
    "set_session_name", "update_todo", "spawn_session", "list_models",
    "subagent", "toggle_plan_mode",
];
const builtinTools = BUILTIN_NAMES.map((name) => ({
    name,
    description: `Built-in tool: ${name}. Executes the ${name} operation in the current working directory and returns the result.`,
    input_schema: {
        type: "object",
        properties: {
            input: { type: "string", description: "Primary input for the operation" },
            options: { type: "string", description: "Optional flags" },
        },
        required: ["input"],
    },
}));

// 32 MCP-shaped tools — realistic names/descriptions/schemas like the
// godmother + jules servers would register.
const MCP_VERBS = [
    "capture_idea", "search_ideas", "list_ideas", "move_idea", "get_idea",
    "branch_idea", "update_idea", "link_ideas", "related_ideas", "get_epic",
    "update_epic", "list_epics", "create_epic", "delete_idea", "list_topics",
    "tag_idea",
];
const mcpTools = [
    ...MCP_VERBS.map((verb) => ({
        name: `mcp_godmother_${verb}`,
        description: `Godmother idea tracker: ${verb.replace(/_/g, " ")}. Operates on the semantic idea/task store with projects, topics, blocking dependencies, and vector search. Returns structured JSON describing the affected ideas and their statuses.`,
        input_schema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Idea identifier (ULID)" },
                query: { type: "string", description: "Semantic search query text" },
                project: { type: "string", description: "Project name filter" },
                status: { type: "string", enum: ["capture", "triage", "design", "plan", "execute", "completed", "review", "shipped"] },
                topics: { type: "array", items: { type: "string" }, description: "Topic tags" },
                summary: { type: "string", description: "One-line summary" },
            },
            required: [],
        },
    })),
    ...MCP_VERBS.map((verb) => ({
        name: `mcp_jules_${verb}`,
        description: `Jules dispatch: ${verb.replace(/_/g, " ")}. Manages remote coding task sessions — creation, monitoring, activity feeds, and PR publication for asynchronous task execution.`,
        input_schema: {
            type: "object",
            properties: {
                session_id: { type: "string", description: "Jules session identifier" },
                prompt: { type: "string", description: "Task prompt" },
                repo: { type: "string", description: "owner/name of the target repository" },
                branch: { type: "string", description: "Starting branch" },
            },
            required: [],
        },
    })),
];

const fewTools = builtinTools.slice(0, 4);
const searchToolsTool = {
    name: "search_tools",
    description: "Search for available tools by keyword query. Some tools are deferred to save context space — use this to discover and load them. Returns matching tool names and descriptions; matched tools are automatically loaded.",
    input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "Search query — keywords describing the tool you need" } },
        required: ["query"],
    },
};

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

// Known-good request shape (fable-5, adaptive thinking) held constant; only
// the tools array and system size vary per case.
const GOOD = {
    model: "claude-fable-5",
    beta: BASE_BETA + FALLBACK_BETA,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
    fallbacks: [{ model: "claude-opus-4-8" }],
    max_tokens: 128000,
} as const;

// Round 1 findings (2026-07-03): system size is NOT the trigger (63k-char
// system + 4 tools → 200). The tools axis IS: 26 tools → 200, 32 tools → 400
// "out of extra usage" (request classified out of the subscription bucket).
const round1: Case[] = [
    { ...GOOD, label: "A0 baseline: small sys, 4 tools",
      system: smallSystem, tools: fewTools },

    { ...GOOD, label: "T1 today's PizzaPi: small sys, 26 builtin tools",
      system: smallSystem, tools: builtinTools },

    { ...GOOD, label: "T2 deferred end-state: small sys, 26 builtin + search_tools + 5 MCP (32 tools)",
      system: smallSystem, tools: [...builtinTools, searchToolsTool, ...mcpTools.slice(0, 5)] },

    { ...GOOD, label: "T3 eager MCP: small sys, 26 builtin + 32 MCP tools (58 tools)",
      system: smallSystem, tools: [...builtinTools, ...mcpTools] },

    { ...GOOD, label: "S1 system axis: BIG sys (~63k chars), 4 tools",
      system: bigSystem, tools: fewTools },

    { ...GOOD, label: "B1 combined: BIG sys + 58 tools",
      system: bigSystem, tools: [...builtinTools, ...mcpTools] },
];

// Round 2: binary-search the tools axis — count vs bytes vs naming shape.
const genericExtra = (n: number) => Array.from({ length: n }, (_, i) => ({
    name: `extra_tool_${i + 1}`,
    description: `Extra generic tool ${i + 1}. Performs an auxiliary operation and returns the result.`,
    input_schema: {
        type: "object",
        properties: { input: { type: "string", description: "Primary input" } },
        required: ["input"],
    },
}));
const ccStyleMcp = mcpTools.slice(0, 5).map((t) => ({
    ...t,
    name: t.name.replace(/^mcp_godmother_/, "mcp__godmother__"),
}));
const fatBuiltinTools = builtinTools.map((t) => ({
    ...t,
    description: t.description + " " + "This tool participates in the PizzaPi agent harness and returns structured results suitable for downstream orchestration. ".repeat(2),
}));

const round2: Case[] = [
    { ...GOOD, label: "R1 count 27: 26 builtin + 1 generic",
      system: smallSystem, tools: [...builtinTools, ...genericExtra(1)] },

    { ...GOOD, label: "R2 count 32: 26 builtin + 6 generic",
      system: smallSystem, tools: [...builtinTools, ...genericExtra(6)] },

    { ...GOOD, label: "R3 search_tools only: 26 builtin + search_tools (27)",
      system: smallSystem, tools: [...builtinTools, searchToolsTool] },

    { ...GOOD, label: "R4 mcp_ single-underscore: 26 builtin + 5 mcp_godmother_* (31)",
      system: smallSystem, tools: [...builtinTools, ...mcpTools.slice(0, 5)] },

    { ...GOOD, label: "R5 mcp__ CC-style: 26 builtin + 5 mcp__godmother__* (31)",
      system: smallSystem, tools: [...builtinTools, ...ccStyleMcp] },

    { ...GOOD, label: "R6 bytes axis: 26 builtin with fat descriptions (~14KB tools)",
      system: smallSystem, tools: fatBuiltinTools },
];

// Round 2 findings (2026-07-03): count (R2: 32 generic → 200), bytes (R6:
// 16KB tools → 200), and search_tools (R3 → 200) are all fine. The trigger is
// naming: `mcp_x_y` single-underscore → 400 (R4); the SAME tools renamed to
// Claude Code's canonical `mcp__x__y` → 200 (R5).

// Round 3: confirm eager full-MCP exposure passes with CC-style naming.
const ccStyleAll = mcpTools.map((t) => ({
    ...t,
    name: t.name.replace(/^mcp_(godmother|jules)_/, "mcp__$1__"),
}));
const round3: Case[] = [
    { ...GOOD, label: "F1 eager CC-style: 26 builtin + 32 mcp__* (58 tools)",
      system: smallSystem, tools: [...builtinTools, ...ccStyleAll] },

    { ...GOOD, label: "F2 eager CC-style + BIG sys: 58 tools + 63k system",
      system: bigSystem, tools: [...builtinTools, ...ccStyleAll] },
];

const cases: Case[] = process.argv.includes("--round1") ? round1
    : process.argv.includes("--round2") ? round2
    : round3;

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

    let status = 0, errMsg = "";
    let rlHeaders: Record<string, string> = {};
    let attempts = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
        attempts = attempt + 1;
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
        rlHeaders = {};
        res.headers.forEach((v, k) => {
            if (k.startsWith("anthropic-ratelimit")) rlHeaders[k] = v;
        });
        // A 429 on this case IS the signal — record it, retry to see if transient.
        if (status === 429) { errMsg = await res.text(); await sleep(15000); continue; }
        // stream:true returns 200 then may error mid-stream — must read the body.
        errMsg = await res.text();
        break;
    }
    const bodyBytes = Buffer.byteLength(JSON.stringify(body));
    console.log(`\n===== ${c.label} =====`);
    console.log(`tools=${c.tools.length} sysChars=${c.system.length} bodyBytes=${bodyBytes} attempts=${attempts}`);
    console.log(`HTTP ${status}`);
    for (const [k, v] of Object.entries(rlHeaders).sort()) console.log(`  ${k}: ${v}`);
    if (status !== 200) {
        console.log(`--- response body ---`);
        console.log(errMsg.slice(0, 2000));
        console.log(`--- end ---`);
    } else {
        // don't dump the whole SSE stream — just confirm it completed vs errored.
        const midStreamError = errMsg.includes('"type":"error"');
        console.log(`stream: ${midStreamError ? "ERROR mid-stream" : "ok"} (${errMsg.length} bytes)`);
        if (midStreamError) console.log(errMsg.slice(errMsg.indexOf('"type":"error"') - 100, errMsg.indexOf('"type":"error"') + 800));
    }
    await sleep(6000);
}
