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
//
// SECURITY: the extracted literal is parsed with JSON.parse, never
// evaluated. Listing/discovery reads workflow files from disk (including,
// potentially, an untrusted cloned repo's `.pizzapi/workflows/`) — merely
// listing must never execute file contents. saveWorkflow always writes meta
// via JSON.stringify, so legitimate files are valid JSON; anything else
// (including a deliberately malicious `meta` block) just fails to parse and
// is treated as absent metadata.
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
        const value: unknown = JSON.parse(objLiteral);
        if (value && typeof value === "object" && typeof (value as Record<string, unknown>).name === "string") {
            const v = value as Record<string, unknown>;
            meta = { name: v.name as string, description: typeof v.description === "string" ? v.description : undefined };
        }
    } catch {
        // Malformed/non-JSON meta block — treat as absent, still try to run the script.
        // NEVER fall back to eval here (that's the exact RCE this replaced).
    }

    const script = (content.slice(0, match.index) + content.slice(afterEnd)).trim();
    return { meta, script };
}

export function listSavedWorkflows(cwd: string, scope: "project" | "user" | "both" = "both"): SavedWorkflowInfo[] {
    const dirs = workflowDirs(cwd);
    const byName = new Map<string, SavedWorkflowInfo>();

    // SECURITY/CORRECTNESS: only scan the requested scope's directory. If we
    // scanned both and filtered afterwards, a project-scope workflow would
    // shadow (hide) a same-named user-scope workflow even when the caller
    // explicitly asked for scope:"user" — filtering must happen before
    // shadowing, which in practice means never reading the other scope's dir
    // at all when a specific scope was requested.
    const scopesToScan =
        scope === "both"
            ? ([
                  ["user", dirs.user],
                  ["project", dirs.project],
              ] as const)
            : scope === "user"
              ? ([["user", dirs.user]] as const)
              : ([["project", dirs.project]] as const);

    for (const [scopeName, dir] of scopesToScan) {
        let files: string[];
        try {
            files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
        } catch (err) {
            // A missing workflows dir just means "no saved workflows in this
            // scope yet" — fine, keep scanning other scopes. Anything else
            // (EACCES, EIO, ...) is a real problem the caller needs to know
            // about, not silently-empty results.
            if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw err;
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
            byName.set(name, { name, scope: scopeName, path: filePath, meta });
        }
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// SECURITY: refuse to write through a symlink. `root` is a trusted path we
// already control (cwd or HOME); `target` is a path built underneath it
// (e.g. `<cwd>/.pizzapi/workflows/name.js`). Walk each path segment between
// root and target that already exists on disk and reject if any of them
// (an intermediate dir OR the final file) is a symlink — a cloned repo
// could otherwise ship `.pizzapi/workflows` (or a single workflow file) as
// a symlink pointing outside the workflows dir, turning a routine save into
// an overwrite of an arbitrary file on disk.
function assertNoSymlinkInPath(root: string, target: string): void {
    const rel = path.relative(root, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`Refusing to write outside ${root}: ${target}`);
    }
    let current = root;
    for (const segment of rel.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        let st: fs.Stats;
        try {
            st = fs.lstatSync(current);
        } catch {
            continue; // doesn't exist yet — will be created for real, nothing to check
        }
        if (st.isSymbolicLink()) {
            throw new Error(`Refusing to write through symlink: ${current}`);
        }
    }
}

/**
 * Starter script for a new saved workflow — the boilerplate most scripts
 * need (guard against missing `args`, one `agent()` call, one `pipeline()`
 * fan-out) with comments explaining each of the four injected names. Meant
 * to be edited, not run as-is.
 */
export function workflowTemplate(): string {
    const lines = [
        "// Four names are injected into every workflow script:",
        "//   agent(prompt, opts?)   \u2014 run one subagent, returns its text (or a",
        "//                            parsed object if opts.schema is set)",
        "//   pipeline(list, fn)     \u2014 run fn(item, index) over every item in",
        "//                            `list` with bounded concurrency (<=16 at",
        "//                            once), typically calling agent() inside fn",
        "//   args                   \u2014 whatever was passed to run_workflow /",
        "//                            run_saved_workflow / `/workflow name {...}`",
        "//   console                \u2014 normal console, for your own debugging",
        "//",
        "// Only the script's `return` value comes back to the caller \u2014 everything",
        "// else (every agent()'s output, every pipeline() intermediate) stays out",
        "// of context. Guard against a missing `args` so `/workflow <name>` with",
        "// no JSON still runs something sensible.",
        "",
        'const items = args?.items ?? ["example-a", "example-b"];',
        "",
        "const results = await pipeline(items, async (item) => {",
        "  const summary = await agent(`Summarize ${item} in one sentence.`, { label: item });",
        "  return { item, summary };",
        "});",
        "",
        "return results;",
        "",
    ];
    return lines.join("\n");
}

export function saveWorkflow(
    cwd: string,
    opts: { name: string; script: string; scope?: "project" | "user"; description?: string },
): string {
    const dirs = workflowDirs(cwd);
    const scope = opts.scope ?? "project";
    const root = scope === "project" ? cwd : process.env.HOME || homedir();
    const dir = scope === "project" ? dirs.project : dirs.user;

    assertNoSymlinkInPath(root, dir);
    fs.mkdirSync(dir, { recursive: true });

    const safeName = sanitizeAgentFileSegment(opts.name);
    const filePath = path.join(dir, `${safeName}.js`);
    assertNoSymlinkInPath(root, filePath);

    const meta: WorkflowMeta = { name: safeName, description: opts.description };
    const metaHeader = `export const meta = ${JSON.stringify(meta, null, 2)};\n\n`;
    const content = metaHeader + opts.script.trimStart();

    // SECURITY: write-then-rename instead of writeFileSync(filePath, ...)
    // directly. writeFileSync follows a symlink at `filePath` and writes
    // THROUGH it to wherever it points; renameSync does not — it atomically
    // replaces the destination directory entry itself, so even if an
    // attacker plants a symlink at `filePath` in the instant after the
    // assertNoSymlinkInPath check above, the rename can never be tricked
    // into following it. The temp file is created with "wx" (O_EXCL) so a
    // pre-planted symlink at the temp path can't be written through either.
    // ponytail: this closes the file-level TOCTOU but not the directory one
    // — an attacker with local write access to `dir` could still swap an
    // intermediate path *component* for a symlink between the re-check
    // below and the rename syscall itself. Fully closing that needs
    // O_NOFOLLOW directory-handle traversal (openat), which is
    // over-engineering for this threat model (the workflow author's own
    // project/home dir, not a hostile multi-tenant filesystem) — upgrade
    // there if untrusted-local-attacker hardening is ever required.
    const tempPath = path.join(dir, `.${safeName}.${process.pid}.${Date.now()}.tmp`);
    try {
        fs.writeFileSync(tempPath, content, { flag: "wx" });
        assertNoSymlinkInPath(root, dir);
        fs.renameSync(tempPath, filePath);
    } catch (err) {
        try {
            fs.unlinkSync(tempPath);
        } catch {
            // best-effort cleanup — the write itself may never have succeeded
        }
        throw err;
    }
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
