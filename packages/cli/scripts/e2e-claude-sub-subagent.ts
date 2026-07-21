/**
 * E2E check: subagent engine works with the claude-subscription provider.
 *
 * Registers the provider directly on a real ModelRegistry (same call the
 * minimalcc-pi extension makes), then runs a subagent with an anthropic/*
 * model override — exercising the same-id provider fallback AND shared
 * registry auth. Burns one tiny haiku request.
 *
 * Run: bun scripts/e2e-claude-sub-subagent.ts
 */
import { ModelRegistry, AuthStorage } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";
import { runSingleAgent } from "../src/extensions/subagent/engine.js";
import type { AgentConfig } from "../src/extensions/subagent-agents.js";

const mcc = join(homedir(), ".pizzapi/git/github.com/5omeOtherGuy/minimalcc-pi");
const { MODELS, CLAUDE_SUBSCRIPTION_NATIVE_API_ID } = await import(join(mcc, "src/models.ts"));
const { streamNativeClaudeSubscription } = await import(join(mcc, "src/native-stream-simple.ts"));

const agentDir = join(homedir(), ".pizzapi");
const auth = AuthStorage.create(join(agentDir, "auth.json"));
const registry = ModelRegistry.create(auth, join(agentDir, "models.json"));

registry.unregisterProvider("anthropic");
registry.registerProvider("claude-subscription", {
    name: "Claude subscription (Claude Code OAuth)",
    baseUrl: "https://api.anthropic.com",
    apiKey: "claude-code-oauth-loaded-at-runtime",
    api: CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
    models: [...MODELS],
    streamSimple: streamNativeClaudeSubscription,
});

const agent: AgentConfig = {
    name: "echo",
    description: "test agent",
    tools: ["read"],
    systemPrompt: "You are a test agent. Follow instructions exactly.",
    source: "user",
} as AgentConfig;

const result = await runSingleAgent(
    process.cwd(),
    [agent],
    "echo",
    "Reply with exactly the word: pong",
    undefined,
    undefined,
    undefined,
    undefined,
    (r) => ({ mode: "single", results: r }) as any,
    { provider: "anthropic", id: "claude-haiku-4-5" }, // anthropic → same-id fallback
    registry,
);

console.log("exitCode:", result.exitCode);
console.log("model:", result.model);
console.log("stderr:", result.stderr || "(none)");
const last = result.messages.filter((m: any) => m.role === "assistant").at(-1) as any;
const text = last?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") ?? "";
console.log("output:", JSON.stringify(text.trim()));

if (result.exitCode !== 0 || !/pong/i.test(text)) {
    console.error("E2E FAILED");
    process.exit(1);
}
console.log("E2E PASSED");
