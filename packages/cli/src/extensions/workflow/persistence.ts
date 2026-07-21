/**
 * Save/load saved workflows to/from disk.
 *
 * Project scope: `<cwd>/.pizzapi/workflows/*.js`
 * User scope:    `~/.pizzapi/workflows/*.js`
 *
 * Project shadows user on name conflict (same precedence as agent discovery).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { sanitizeAgentFileSegment } from "../subagent/types.js";
import type { WorkflowMeta } from "./types.js";

export interface SavedWorkflowInfo {
    name: string;
    scope: "project" | "user";
    path: string;
    meta?: WorkflowMeta;
}

export function workflowDirs(cwd: string): { project: string; user: string } {
    return {
        project: path.join(cwd, ".pizzapi", "workflows"),
        // ponytail: process.env.HOME || homedir() — Bun caches os.homedir() at
        // process start and can ignore later HOME overrides, so tests must be
        // able to steer this via the env var directly (same pattern used
        // elsewhere in the CLI, e.g. config/io.ts, plugins/discover.ts).
        user: path.join(process.env.HOME || homedir(), ".pizzapi", "workflows"),
    };
}

// ponytail: regex/brace-matching extraction of a leading
// `export const meta = {...}` object literal — not a full JS parser. Ceiling:
// only handles a single top-level object literal (no template strings
// containing unbalanced braces). Upgrade to a real parser if saved workflows
// need richer metadata.
function extractMeta(content: string): { meta?: WorkflowMeta; script: string } {
    const match = content.match(/^\s*export\s+const\s+meta\s*=\s*(\{)/m);
    if (!match || match.index === undefined) return { script: content };

    const start = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = start; i < content.length; i++) {
        if (content[i] === "{") depth++;
        else if (content[i] === "}") {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end === -1) return { script: content };

    let afterEnd = end + 1;
    if (content[afterEnd] === ";") afterEnd++;

    const objLiteral = content.slice(start, end + 1);
    let meta: WorkflowMeta | undefined;
    try {
        // eslint-disable-next-line no-new-func
        const value = new Function(`return (${objLiteral});`)();
        if (value && typeof value === "object" && typeof value.name === "string") {
            meta = { name: value.name, description: typeof value.description === "string" ? value.description : undefined };
        }
    } catch {
        // Malformed meta block — treat as absent, still try to run the script.
    }

    const script = (content.slice(0, match.index) + content.slice(afterEnd)).trim();
    return { meta, script };
}

export function listSavedWorkflows(cwd: string): SavedWorkflowInfo[] {
    const dirs = workflowDirs(cwd);
    const byName = new Map<string, SavedWorkflowInfo>();

    for (const [scope, dir] of [
        ["user", dirs.user],
        ["project", dirs.project],
    ] as const) {
        let files: string[];
        try {
            files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
        } catch {
            continue;
        }
        for (const file of files) {
            const name = file.slice(0, -3);
            const filePath = path.join(dir, file);
            let meta: WorkflowMeta | undefined;
            try {
                meta = extractMeta(fs.readFileSync(filePath, "utf-8")).meta;
            } catch {
                // Unreadable file — list it anyway without meta.
            }
            // Iterating user first then project means project overwrites,
            // giving project scope precedence on name conflicts.
            byName.set(name, { name, scope, path: filePath, meta });
        }
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function saveWorkflow(
    cwd: string,
    opts: { name: string; script: string; scope?: "project" | "user"; description?: string },
): string {
    const dirs = workflowDirs(cwd);
    const scope = opts.scope ?? "project";
    const dir = scope === "project" ? dirs.project : dirs.user;
    fs.mkdirSync(dir, { recursive: true });

    const safeName = sanitizeAgentFileSegment(opts.name);
    const filePath = path.join(dir, `${safeName}.js`);
    const meta: WorkflowMeta = { name: safeName, description: opts.description };
    const metaHeader = `export const meta = ${JSON.stringify(meta, null, 2)};\n\n`;
    fs.writeFileSync(filePath, metaHeader + opts.script.trimStart());
    return filePath;
}

export function loadWorkflow(cwd: string, name: string): { script: string; meta?: WorkflowMeta } | null {
    const dirs = workflowDirs(cwd);
    const safeName = sanitizeAgentFileSegment(name);

    for (const dir of [dirs.project, dirs.user]) {
        const filePath = path.join(dir, `${safeName}.js`);
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, "utf-8");
            return extractMeta(content);
        }
    }
    return null;
}
