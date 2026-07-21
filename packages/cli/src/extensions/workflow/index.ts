/**
 * Dynamic Workflow Tool — orchestrate many subagents from a single script.
 *
 * Mimics Claude Code's "dynamic workflows": `run_workflow` executes a
 * JavaScript script that calls `agent(prompt)` and `pipeline(list, fn)` to
 * fan out work across isolated subagents. Intermediate agent output lives in
 * script variables, not the parent's context window — only the script's
 * `return` value becomes the tool result.
 *
 * Built on the existing subagent engine (see ../subagent/engine.ts) — no
 * agent-spawning logic is reimplemented here.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runWorkflow } from "./runtime.js";
import { listSavedWorkflows, loadWorkflow, saveWorkflow } from "./persistence.js";
import type { WorkflowDetails } from "./types.js";

// ── Tool parameter schemas (JSON Schema) ───────────────────────────────

const RunWorkflowParams = {
    type: "object",
    properties: {
        script: {
            type: "string",
            description:
                "JavaScript source for an async function body. Receives `agent(prompt, opts?)`, `pipeline(list, mapper)`, `args`, and `console`. `agent()` runs one subagent and returns its text output (or a parsed object if `opts.schema` is set). `pipeline(list, fn)` runs `fn(item, index)` for every item with bounded concurrency, typically calling `agent()` inside `fn`. Use `return` to produce the tool's final result — everything else stays out of your context.",
        },
        args: {
            description: "Optional input passed through to the script as the `args` variable.",
        },
        name: { type: "string", description: "Optional display name for this workflow run." },
        save: {
            type: "object",
            description: "If provided and the run succeeds, persist the script for reuse via run_saved_workflow.",
            properties: {
                name: { type: "string", description: "Name to save the workflow under." },
                scope: { type: "string", enum: ["project", "user"], description: 'Where to save it. Default: "project".' },
            },
            required: ["name"],
        },
    },
    required: ["script"],
} as const;

const ListWorkflowsParams = {
    type: "object",
    properties: {
        scope: { type: "string", enum: ["project", "user", "both"], description: 'Filter by scope. Default: "both".' },
    },
} as const;

const RunSavedWorkflowParams = {
    type: "object",
    properties: {
        name: { type: "string", description: "Name of a previously saved workflow." },
        args: { description: "Optional input passed through to the script as the `args` variable." },
    },
    required: ["name"],
} as const;

// ── Extension factory ──────────────────────────────────────────────────

export const workflowExtension = (pi: ExtensionAPI) => {
    pi.registerTool({
        name: "run_workflow",
        label: "Run Workflow",
        description: [
            "Execute a JavaScript workflow script that orchestrates many subagents via agent()/pipeline() primitives.",
            "Use for large fan-out work — audits, migrations, cross-checked research — where per-subagent output would otherwise flood your context.",
            "Only the script's return value comes back to you; intermediate agent results stay in script variables.",
            `Concurrency is capped at 16 agents and 1000 agents total per run.`,
            'Pass `save: { name }` to persist the script for reuse via run_saved_workflow.',
        ].join(" "),
        parameters: RunWorkflowParams as any,

        async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
            const params = rawParams as {
                script: string;
                args?: unknown;
                name?: string;
                save?: { name: string; scope?: "project" | "user" };
            };

            const { details, text } = await runWorkflow({
                script: params.script,
                args: params.args,
                name: params.name,
                signal,
                ctx: { cwd: ctx.cwd, modelRegistry: ctx.modelRegistry },
                onUpdate: onUpdate
                    ? (d: WorkflowDetails) => onUpdate({ content: [{ type: "text", text: `Workflow: ${d.totalAgents} agent(s), ${d.phases.length} phase(s), ${d.status}` }], details: d })
                    : undefined,
            });

            let saveError: string | undefined;
            if (details.status === "done" && params.save) {
                try {
                    saveWorkflow(ctx.cwd, { name: params.save.name, script: params.script, scope: params.save.scope });
                } catch (err) {
                    saveError = err instanceof Error ? err.message : String(err);
                }
            }

            if (saveError) {
                // The workflow itself ran fine, but the requested `save` did
                // not — that's a genuine failure of what the caller asked for,
                // not a footnote. Surface it as a structured error result
                // (not a "done" status with a text warning) so callers can
                // detect and react to it programmatically.
                const errorDetails: WorkflowDetails = { ...details, status: "error", error: `Workflow completed but failed to save: ${saveError}` };
                return {
                    content: [{ type: "text", text: `${text}\n\nFailed to save workflow: ${saveError}` }],
                    details: errorDetails,
                    isError: true,
                };
            }

            return {
                content: [{ type: "text", text }],
                details,
                ...(details.status === "error" && { isError: true }),
            };
        },
    });

    pi.registerTool({
        name: "list_workflows",
        label: "List Workflows",
        description: "List saved workflows (project and user scope) available to run_saved_workflow.",
        parameters: ListWorkflowsParams as any,

        async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
            const params = rawParams as { scope?: "project" | "user" | "both" };
            const scope = params.scope ?? "both";

            let filtered: ReturnType<typeof listSavedWorkflows>;
            try {
                // Filter by scanning only the requested scope's directory —
                // filtering AFTER a combined/deduped listing would hide a
                // user-scope workflow shadowed by a same-named project one.
                filtered = listSavedWorkflows(ctx.cwd, scope);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text", text: `Failed to list workflows: ${message}` }],
                    details: { status: "error", error: message, workflows: [] },
                    isError: true,
                };
            }

            const text =
                filtered.length === 0
                    ? "No saved workflows."
                    : filtered
                          .map((w) => `- ${w.name} (${w.scope})${w.meta?.description ? `: ${w.meta.description}` : ""}`)
                          .join("\n");

            return {
                content: [{ type: "text", text }],
                details: { workflows: filtered },
            };
        },
    });

    pi.registerTool({
        name: "run_saved_workflow",
        label: "Run Saved Workflow",
        description: "Load and execute a workflow previously saved via run_workflow's `save` option.",
        parameters: RunSavedWorkflowParams as any,

        async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
            const params = rawParams as { name: string; args?: unknown };
            let loaded: ReturnType<typeof loadWorkflow>;
            try {
                loaded = loadWorkflow(ctx.cwd, params.name);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text", text: `Failed to load workflow "${params.name}": ${message}` }],
                    details: { name: params.name, status: "error", phases: [], totalAgents: 0, totalTokens: 0, error: message } satisfies WorkflowDetails,
                    isError: true,
                };
            }
            if (!loaded) {
                return {
                    content: [{ type: "text", text: `No saved workflow named "${params.name}".` }],
                    details: { name: params.name, status: "error", phases: [], totalAgents: 0, totalTokens: 0, error: "not found" } satisfies WorkflowDetails,
                    isError: true,
                };
            }

            const { details, text } = await runWorkflow({
                script: loaded.script,
                args: params.args,
                name: loaded.meta?.name ?? params.name,
                signal,
                ctx: { cwd: ctx.cwd, modelRegistry: ctx.modelRegistry },
                onUpdate: onUpdate
                    ? (d: WorkflowDetails) => onUpdate({ content: [{ type: "text", text: `Workflow: ${d.totalAgents} agent(s), ${d.phases.length} phase(s), ${d.status}` }], details: d })
                    : undefined,
            });

            return {
                content: [{ type: "text", text }],
                details,
                ...(details.status === "error" && { isError: true }),
            };
        },
    });
};

export * from "./types.js";
export * from "./persistence.js";
export { runWorkflow, WORKFLOW_MAX_CONCURRENCY, WORKFLOW_MAX_TOTAL_AGENTS } from "./runtime.js";
