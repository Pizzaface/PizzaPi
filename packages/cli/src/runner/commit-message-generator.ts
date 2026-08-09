/**
 * Model-backed git commit-message generation.
 *
 * "Calls out to PizzaPi": instead of a local heuristic, send the staged diff to
 * a real model (via the runner's configured auth) and let it write a
 * conventional-commit message. Built lazily by the daemon and injected into
 * GitService as `generateCommitMessage`, which falls back to the deterministic
 * heuristic when no model/auth is available.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai/compat";
import { join } from "node:path";
import { registerOllamaCloudProvider } from "../ollama-cloud-models.js";

const SYSTEM_PROMPT = [
    "You write git commit messages.",
    "Given a unified diff of staged changes, write a conventional commit message:",
    "a subject line `type(scope): summary` (type in feat|fix|refactor|chore|docs|test|perf) followed by an optional body.",
    "Reply with ONLY the commit message. No markdown fences, no preamble, no commentary.",
].join("\n");

function userPrompt(diff: string): string {
    return `Staged changes:\n\`\`\`diff\n${diff.slice(0, 20_000)}\n\`\`\`\n\nWrite the conventional commit message.`;
}

/** Pick a cheap/fast model if available, else the first. */
function pickModel(models: readonly Model<any>[]): Model<any> | undefined {
    if (models.length === 0) return undefined;
    const rank = (m: Model<any>) => {
        const id = `${m.provider}/${m.id}`.toLowerCase();
        if (/(mini|flash-lite|haiku)/.test(id)) return 0;
        if (/(flash|3-5-flash|fast)/.test(id)) return 1;
        return 2;
    };
    return [...models].sort((a, b) => rank(a) - rank(b))[0];
}

/** Parse a model reply into a conventional subject + body. Strips fences/preamble. */
export function parseModelMessage(text: string): { subject: string; body: string } {
    let t = (text ?? "").trim();
    // Strip ``` ... ``` fences if present.
    const fence = t.match(/^```(?:diff|text)?\s*\n([\s\S]*?)\n```$/);
    if (fence) t = fence[1].trim();
    // Drop anything before the first conventional-ish subject line.
    const lines = t.split("\n");
    const subjectIdx = lines.findIndex((l) => /^[a-z]+(\([^)]*\))?: .+/.test(l.trim()));
    const subject = (subjectIdx >= 0 ? lines[subjectIdx].trim() : lines[0]?.trim() ?? "");
    const body = (subjectIdx >= 0 ? lines.slice(subjectIdx + 1).join("\n").trim() : lines.slice(1).join("\n").trim());
    return { subject, body };
}

function extractText(msg: AssistantMessage): string {
    return (msg.content ?? [])
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
}

export interface CommitMessageGenerator {
    generate(diff: string): Promise<{ subject: string; body: string } | null>;
}

/**
 * Build a generator that calls a real model through the runner's auth.
 * Returns a generator whose `generate` returns null on any failure (no auth,
 * no model, provider error) so the caller can fall back to a heuristic.
 */
export function makeCommitMessageGenerator(agentDir: string): CommitMessageGenerator {
    return {
        async generate(diff: string): Promise<{ subject: string; body: string } | null> {
            if (!diff || !diff.trim()) return null;
            let runtime: ModelRuntime;
            try {
                runtime = await ModelRuntime.create({
                    authPath: join(agentDir, "auth.json"),
                    modelsPath: join(agentDir, "models.json"),
                });
            } catch {
                return null;
            }
            // Mirror the daemon's listConfiguredModels: extension providers don't
            // load here, so make ollama-cloud resolvable explicitly.
            try {
                registerOllamaCloudProvider(runtime);
            } catch {
                // ignore — provider registration is best-effort
            }

            const available = runtime.getAvailableSnapshot();
            const model = pickModel(available);
            if (!model) return null;

            const context: Context = {
                systemPrompt: SYSTEM_PROMPT,
                messages: [{ role: "user", content: userPrompt(diff), timestamp: Date.now() }],
            };

            try {
                const result = await Promise.race([
                    runtime.completeSimple(model, context),
                    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("commit message generation timed out")), 30_000)),
                ]);
                const text = extractText(result);
                if (!text) return null;
                const parsed = parseModelMessage(text);
                if (!parsed.subject) return null;
                return parsed;
            } catch {
                return null;
            }
        },
    };
}
