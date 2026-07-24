// Per-project memory storage. Machine-local, keyed by git root (fallback cwd).
// Layout: ~/.pizzapi/memory/<project-key>/{MEMORY.md, <topic>.md, recaps.md}
//
// Shared by the memory extension (context injection + tools + /memory command)
// and the recap flow (/recap, resume auto-recap). The agent writes here via the
// memory_* tools; the index auto-loads into every session's system prompt.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const MAX_INDEX_LINES = 200;
export const MAX_INDEX_BYTES = 25 * 1024;

const INDEX = "MEMORY.md";
const RECAPS = "recaps.md";

function root(): string {
  return join(process.env.HOME || homedir(), ".pizzapi", "memory");
}

/** Stable per-repo key: <basename>-<8-char hash of abs path>. Shared across worktrees of one repo. */
export function projectKey(cwd = process.cwd()): string {
  let base = cwd;
  try {
    base =
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || cwd;
  } catch {
    // not a git repo — use cwd
  }
  const hash = createHash("sha256").update(base).digest("hex").slice(0, 8);
  const name = basename(base).replace(/[^A-Za-z0-9._-]/g, "_") || "project";
  return `${name}-${hash}`;
}

export function memoryDir(cwd?: string): string {
  const dir = join(root(), projectKey(cwd));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function safeTopic(topic: string): string {
  const name = basename(topic).replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.md$/i, "");
  if (!name) throw new Error("invalid topic name");
  return `${name}.md`;
}

function filePath(cwd: string | undefined, file: string): string {
  return join(memoryDir(cwd), file);
}

export interface CapInfo {
  lines: number;
  bytes: number;
  overLimit: boolean;
  nearLimit: boolean;
}

export function capInfo(text: string): CapInfo {
  const lines = text.length === 0 ? 0 : text.split("\n").length;
  const bytes = Buffer.byteLength(text, "utf-8");
  return {
    lines,
    bytes,
    overLimit: lines > MAX_INDEX_LINES || bytes > MAX_INDEX_BYTES,
    nearLimit: lines > MAX_INDEX_LINES * 0.9 || bytes > MAX_INDEX_BYTES * 0.9,
  };
}

/** Read the index, truncated to what actually loads into context. Returns "" if none. */
export function readIndexTruncated(cwd?: string): { text: string; truncated: boolean } {
  const p = filePath(cwd, INDEX);
  if (!existsSync(p)) return { text: "", truncated: false };
  const raw = readFileSync(p, "utf-8");
  const lines = raw.split("\n");
  let truncated = false;
  let out = raw;
  if (lines.length > MAX_INDEX_LINES) {
    out = lines.slice(0, MAX_INDEX_LINES).join("\n");
    truncated = true;
  }
  if (Buffer.byteLength(out, "utf-8") > MAX_INDEX_BYTES) {
    out = Buffer.from(out, "utf-8").subarray(0, MAX_INDEX_BYTES).toString("utf-8");
    truncated = true;
  }
  return { text: out, truncated };
}

export function readIndexRaw(cwd?: string): string {
  const p = filePath(cwd, INDEX);
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

/** Append a one-line entry to the index. If detail+topic given, write detail to a topic file and link it. */
export function saveMemory(
  args: { summary: string; detail?: string; topic?: string },
  cwd?: string,
): { indexCap: CapInfo; wroteTopic?: string } {
  const summary = args.summary.trim().replace(/\n+/g, " ");
  if (!summary) throw new Error("summary required");
  let line = `- ${summary}`;
  let wroteTopic: string | undefined;
  if (args.detail && args.topic) {
    const file = safeTopic(args.topic);
    appendFileSync(filePath(cwd, file), `\n${args.detail.trim()}\n`, { mode: 0o600 });
    wroteTopic = file;
    line += ` (see ${file})`;
  }
  const p = filePath(cwd, INDEX);
  const prefix = existsSync(p) && readFileSync(p, "utf-8").length > 0 ? "" : "# Project Memory\n\n";
  appendFileSync(p, `${prefix}${line}\n`, { mode: 0o600 });
  return { indexCap: capInfo(readIndexRaw(cwd)), wroteTopic };
}

export function appendTopic(topic: string, text: string, cwd?: string): string {
  const file = safeTopic(topic);
  appendFileSync(filePath(cwd, file), `\n${text.trim()}\n`, { mode: 0o600 });
  return file;
}

export function editFile(file: string, oldText: string, newText: string, cwd?: string): void {
  const name = file === INDEX ? INDEX : safeTopic(file);
  const p = filePath(cwd, name);
  if (!existsSync(p)) throw new Error(`no such memory file: ${name}`);
  const cur = readFileSync(p, "utf-8");
  if (!cur.includes(oldText)) throw new Error(`oldText not found in ${name}`);
  if (cur.split(oldText).length > 2) throw new Error(`oldText is not unique in ${name}`);
  writeFileSync(p, cur.replace(oldText, newText), { mode: 0o600 });
}

export function writeMemoryFile(file: string, content: string, cwd?: string): void {
  const name = file === INDEX ? INDEX : safeTopic(file);
  writeFileSync(filePath(cwd, name), content, { mode: 0o600 });
}

export function readMemoryFile(file: string, cwd?: string): string {
  const name = file === INDEX ? INDEX : safeTopic(file);
  const p = filePath(cwd, name);
  if (!existsSync(p)) throw new Error(`no such memory file: ${name}`);
  return readFileSync(p, "utf-8");
}

export function listFiles(cwd?: string): Array<{ file: string; bytes: number; lines: number }> {
  const dir = memoryDir(cwd);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const t = readFileSync(join(dir, f), "utf-8");
      return { file: f, bytes: Buffer.byteLength(t, "utf-8"), lines: t.split("\n").length };
    });
}

export function appendRecap(text: string, cwd?: string): void {
  const stamp = new Date().toISOString();
  appendFileSync(filePath(cwd, RECAPS), `\n## ${stamp}\n${text.trim()}\n`, { mode: 0o600 });
}

export function latestRecap(cwd?: string): string | null {
  const p = filePath(cwd, RECAPS);
  if (!existsSync(p)) return null;
  const blocks = readFileSync(p, "utf-8").split(/\n## /).filter(Boolean);
  const last = blocks[blocks.length - 1];
  if (!last) return null;
  const nl = last.indexOf("\n");
  return nl === -1 ? "" : last.slice(nl + 1).trim();
}
