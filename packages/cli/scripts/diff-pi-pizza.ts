/**
 * A/B diff of the real Anthropic /v1/messages wire request: vanilla `pi` vs
 * `pizza`, both routed through the minimalcc-pi claude-subscription provider.
 *
 * Run: cd packages/cli && bun scripts/diff-pi-pizza.ts [options]
 *
 * Options:
 *   --live          actually send the requests (default: abort after capture,
 *                   so no subscription tokens are spent)
 *   --model <id>    force the same model on both legs (e.g. claude-opus-4-6)
 *   --prompt <txt>  prompt to send (default "hi")
 *   --safe          pizza leg skips MCP/plugins/hooks (isolates pizza's own
 *                   prompt/tool additions from third-party ones)
 *   --no-mcp        pizza leg skips MCP tools
 *   --no-plugins    pizza leg skips Claude Code plugins
 *   --no-hooks      pizza leg skips hooks
 *   --no-agents     pizza leg omits AGENTS.md automatic context
 *
 * pi leg:    spawns the real `pi` binary with scripts/wire-tap.ts via -e
 * pizza leg: builds the session exactly like src/index.ts (same config,
 *            extension factories, skills, plugins, system prompt) in-process
 *            and sends the same prompt
 *
 * The captures include the fetch-time call stack, which proves which module
 * actually built the request (minimalcc-pi's native transport vs pi-ai's
 * built-in anthropic provider).
 */

import {
    createAgentSessionFromServices,
    createAgentSessionServices,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
    applyProviderSettingsEnv,
    defaultAgentDir,
    expandHome,
    loadConfig,
    maybeBuildSystemPrompt,
} from "../src/config.js";
import { getPluginSkillPaths } from "../src/extensions/claude-plugins.js";
import { buildPizzaPiExtensionFactories } from "../src/extensions/factories.js";
import { buildPromptTemplatePaths, buildSkillPaths, createAgentsFilesOverride } from "../src/skills.js";
import { installWireTap } from "./wire-tap.js";

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const live = argv.includes("--live");
const safe = argv.includes("--safe");
const noMcp = safe || argv.includes("--no-mcp");
const noPlugins = safe || argv.includes("--no-plugins");
const noHooks = safe || argv.includes("--no-hooks");
const noAgents = argv.includes("--no-agents");
// A bare model id (e.g. claude-fable-5) can match the built-in `anthropic`
// provider on both legs — always resolve against claude-subscription unless
// the caller explicitly qualifies the provider.
const rawModelArg = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : undefined;
const [modelProvider, modelArg] = rawModelArg?.includes("/")
    ? [rawModelArg.split("/")[0]!, rawModelArg.split("/")[1]]
    : ["claude-subscription", rawModelArg];
const promptText = argv.includes("--prompt") ? argv[argv.indexOf("--prompt") + 1]! : "hi";

const captureDir = join(tmpdir(), `wire-diff-${Date.now()}`);
mkdirSync(captureDir, { recursive: true });
const piOut = join(captureDir, "pi.jsonl");
const pizzaOut = join(captureDir, "pizza.jsonl");
// pi loads -e extension files in a separate module realm whose globalThis is
// not the one the provider reads, so the tap must be preloaded via NODE_OPTIONS.
const preloadPath = join(import.meta.dirname, "wire-tap-preload.mjs");

type Capture = {
    label: string;
    runtime: { execPath: string; argv: string[]; bun: string | null; node: string };
    url: string;
    method: string;
    headers: Record<string, string>;
    bodyBytes: number | null;
    body: Record<string, any>;
    stack: string[];
};

type ResponseCapture = {
    label: string;
    url: string;
    status: number;
    statusText: string;
};

// ── leg 1: vanilla pi (real binary, tap injected via -e) ────────────────────
console.log(`captures → ${captureDir}`);
console.log(`\n[1/2] running vanilla pi (${live ? "LIVE" : "abort-after-capture"})...`);
{
    const args = ["-a", "-p"];
    if (modelArg) args.push("--model", `${modelProvider}/${modelArg}`);
    args.push(promptText);
    const res = spawnSync("pi", args, {
        env: {
            ...process.env,
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${preloadPath}`.trim(),
            WIRE_CAPTURE_OUT: piOut,
            WIRE_CAPTURE_ABORT: live ? "0" : "1",
        },
        encoding: "utf-8",
        timeout: 180_000,
    });
    if (!existsSync(piOut)) {
        console.error("pi leg produced no capture. stdout/stderr:");
        console.error(res.stdout?.slice(-2000));
        console.error(res.stderr?.slice(-2000));
        process.exit(1);
    }
}

// ── leg 2: pizza (in-process, mirrors src/index.ts construction) ────────────
console.log(`[2/2] running pizza session in-process (${safe ? "safe mode" : "custom mode"})...`);
process.env.WIRE_CAPTURE_OUT = pizzaOut;
process.env.WIRE_CAPTURE_ABORT = live ? "0" : "1";
process.env.PIZZAPI_RELAY_URL = "off";
installWireTap("pizza");

const cwd = process.cwd();
const config = loadConfig(cwd);
const agentDir = config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();
applyProviderSettingsEnv(config);

const extensionFactories = buildPizzaPiExtensionFactories({
    cwd,
    hooks: noHooks ? undefined : config.hooks,
    skipMcp: noMcp,
    skipPlugins: noPlugins,
    skipRelay: true,
}).filter((factory: any) => factory.displayName !== "provider-request-log");
const agentsFilesOverride = createAgentsFilesOverride(cwd, {
    sendAgentsMd: noAgents ? false : config.sendAgentsMd !== false,
});
const services = await createAgentSessionServices({
    cwd,
    agentDir,
    resourceLoaderOptions: {
        extensionFactories: extensionFactories as any,
        additionalSkillPaths: [
            ...buildSkillPaths(cwd, config.skills),
            ...(noPlugins ? [] : getPluginSkillPaths(cwd)),
        ],
        additionalPromptTemplatePaths: buildPromptTemplatePaths(cwd),
        ...(config.systemPrompt !== undefined && { systemPromptOverride: () => config.systemPrompt }),
        appendSystemPrompt: [maybeBuildSystemPrompt(config, { cwd }), config.appendSystemPrompt].filter(Boolean) as string[],
        ...(agentsFilesOverride && { agentsFilesOverride }),
    },
});
const sessionManager = SessionManager.create(cwd, join(captureDir, "sessions"));
const modelOverride = modelArg
    ? services.modelRegistry.find(modelProvider, modelArg)
    : undefined;
if (modelArg && !modelOverride) {
    console.error(`--model ${modelProvider}/${modelArg}: not found in pizza's model registry`);
    process.exit(1);
}
const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(modelOverride && { model: modelOverride as any }),
});
console.log(`  pizza session model: ${session.model?.provider}/${session.model?.id}`);
console.log(`  pizza effective system prompt: ${session.systemPrompt.length} chars`);
console.log(`  pizza tools: ${session.getAllTools().length}`);
try {
    await session.prompt(promptText);
} catch {
    // aborted request surfaces as an error turn — expected in capture mode
}

// ── diff ────────────────────────────────────────────────────────────────────
function readCapture(file: string, name: string): Capture {
    const line = existsSync(file)
        ? readFileSync(file, "utf-8").split("\n").find((l) => l.includes('"url"'))
        : undefined;
    if (!line) {
        console.error(`${name} leg produced no request capture (${file})`);
        process.exit(1);
    }
    return JSON.parse(line) as Capture;
}
const pi = readCapture(piOut, "pi");
const pizza = readCapture(pizzaOut, "pizza");

function readResponseCapture(file: string): ResponseCapture | undefined {
    if (!existsSync(file)) return undefined;
    const line = readFileSync(file, "utf-8")
        .split("\n")
        .find((l) => l.includes('"marker":"fetch-response"'));
    return line ? JSON.parse(line) as ResponseCapture : undefined;
}
const piResponse = readResponseCapture(piOut);
const pizzaResponse = readResponseCapture(pizzaOut);

const sha8 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);
const head = (s: string, n = 70) => s.replace(/\s+/g, " ").slice(0, n);
const pad = (s: string, n: number) => s.padEnd(n);

function section(title: string): void {
    console.log(`\n━━ ${title} ${"━".repeat(Math.max(0, 66 - title.length))}`);
}

function row(key: string, a: unknown, b: unknown): void {
    const as = a === undefined ? "—" : JSON.stringify(a);
    const bs = b === undefined ? "—" : JSON.stringify(b);
    const mark = as === bs ? "  " : "≠ ";
    console.log(`${mark}${pad(key, 34)} pi: ${as}`);
    if (as !== bs) console.log(`  ${pad("", 34)} pz: ${bs}`);
}

section("runtime");
row("execPath", pi.runtime.execPath, pizza.runtime.execPath);
row("engine", pi.runtime.bun ? `bun ${pi.runtime.bun}` : `node ${pi.runtime.node}`,
    pizza.runtime.bun ? `bun ${pizza.runtime.bun}` : `node ${pizza.runtime.node}`);

section("request sender (fetch call stack, top frames)");
console.log("pi:");
for (const f of pi.stack.slice(0, 5)) console.log(`    ${f}`);
console.log("pizza:");
for (const f of pizza.stack.slice(0, 5)) console.log(`    ${f}`);

section("url / method / response");
row("url", pi.url, pizza.url);
row("method", pi.method, pizza.method);
row("response status", piResponse?.status, pizzaResponse?.status);
row("response statusText", piResponse?.statusText, pizzaResponse?.statusText);

section("headers");
for (const k of [...new Set([...Object.keys(pi.headers), ...Object.keys(pizza.headers)])].sort()) {
    row(k, pi.headers[k], pizza.headers[k]);
}

section("body: scalar fields");
const skip = new Set(["system", "messages", "tools"]);
for (const k of [...new Set([...Object.keys(pi.body), ...Object.keys(pizza.body)])].sort()) {
    if (!skip.has(k)) row(k, pi.body[k], pizza.body[k]);
}

section("body: system blocks");
type Block = { text?: string; cache_control?: unknown };
const sysBlocks = (b: Record<string, any>): Block[] =>
    typeof b.system === "string" ? [{ text: b.system }] : (b.system ?? []);
const piSys = sysBlocks(pi.body);
const pzSys = sysBlocks(pizza.body);
const totalChars = (blocks: Block[]) => blocks.reduce((n, b) => n + (b.text?.length ?? 0), 0);
console.log(`  pi: ${piSys.length} block(s), ${totalChars(piSys)} chars | pizza: ${pzSys.length} block(s), ${totalChars(pzSys)} chars`);
const pzShas = new Set(pzSys.map((b) => sha8(b.text ?? "")));
const piShas = new Set(piSys.map((b) => sha8(b.text ?? "")));
for (const [who, blocks, otherShas] of [["pi", piSys, pzShas], ["pizza", pzSys, piShas]] as const) {
    blocks.forEach((b, i) => {
        const h = sha8(b.text ?? "");
        const match = otherShas.has(h) ? "= both " : `only ${who}`;
        console.log(`  [${who} #${i}] ${match} sha:${h} ${String(b.text?.length ?? 0).padStart(6)}ch${b.cache_control ? " (cached)" : ""}  "${head(b.text ?? "")}"`);
    });
}

section("body: tools");
type ToolDef = { name?: string; input_schema?: unknown };
const piTools: ToolDef[] = pi.body.tools ?? [];
const pzTools: ToolDef[] = pizza.body.tools ?? [];
const toolBytes = (tools: ToolDef[]) => Buffer.byteLength(JSON.stringify(tools));
console.log(`  pi: ${piTools.length} tools (${toolBytes(piTools)} bytes) | pizza: ${pzTools.length} tools (${toolBytes(pzTools)} bytes)`);
const piNames = new Set(piTools.map((t) => t.name));
const pzNames = new Set(pzTools.map((t) => t.name));
const onlyPi = [...piNames].filter((n) => !pzNames.has(n));
const onlyPz = [...pzNames].filter((n) => !piNames.has(n));
if (onlyPi.length) console.log(`  only pi:    ${onlyPi.join(", ")}`);
if (onlyPz.length) console.log(`  only pizza: ${onlyPz.join(", ")}`);
for (const n of [...piNames].filter((x) => pzNames.has(x))) {
    const a = JSON.stringify(piTools.find((t) => t.name === n));
    const b = JSON.stringify(pzTools.find((t) => t.name === n));
    if (a !== b) console.log(`  shared tool '${n}' differs: pi ${a.length}B vs pizza ${b.length}B`);
}

section("body: messages");
const roles = (b: Record<string, any>) => (b.messages ?? []).map((m: any) => m.role).join(",");
row("count", (pi.body.messages ?? []).length, (pizza.body.messages ?? []).length);
row("roles", roles(pi.body), roles(pizza.body));

section("totals");
row("body bytes", pi.bodyBytes, pizza.bodyBytes);
row("~input tokens (bytes/4)", Math.round((pi.bodyBytes ?? 0) / 4), Math.round((pizza.bodyBytes ?? 0) / 4));

section("agent settings (defaults each CLI reads)");
try {
    const piSettings = JSON.parse(readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf-8"));
    const pzSettings = JSON.parse(readFileSync(join(homedir(), ".pizzapi/settings.json"), "utf-8"));
    for (const k of [...new Set([...Object.keys(piSettings), ...Object.keys(pzSettings)])].sort()) {
        row(k, piSettings[k], pzSettings[k]);
    }
} catch (err) {
    console.log(`  (could not read settings: ${err instanceof Error ? err.message : String(err)})`);
}

console.log(`\nraw captures: ${piOut}\n              ${pizzaOut}`);
process.exit(0);
