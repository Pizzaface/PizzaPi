import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import * as S from "./storage.js";

/**
 * Memory + Recaps extension (Claude Code parity, built into PizzaPi).
 *
 * Memory: a per-project findings store the agent writes to (autonomously via the
 * memory_* tools, or on command) and that auto-loads into every session's system
 * prompt. Machine-local under ~/.pizzapi/memory/<project-key>/, keyed by git root.
 *
 * Recaps: `/recap` asks the model for a one-line "where you left off" summary and
 * saves it; on session resume the last saved recap is surfaced automatically.
 */
export const memoryExtension: ExtensionFactory = (pi) => {
  const cwd = () => process.env.PIZZAPI_PROJECT_DIR || process.cwd();
  // Tools throw on failure (per the pi tool contract); the agent loop encodes
  // the thrown message as an error tool result.
  const ok = (obj: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(obj) }],
    details: undefined,
  });

  // ── Tools ──────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "memory_save",
    label: "Save Memory",
    description:
      "Persist a notable finding to project memory so it auto-loads in future sessions. " +
      "Use for build gotchas, corrections you had to make, conventions, and architecture facts — " +
      "anything you'd otherwise rediscover next session. Give a one-line `summary` for the always-loaded " +
      "index; add `detail`+`topic` for longer notes stored in a topic file.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One-line fact for the always-loaded index" },
        detail: { type: "string", description: "Optional longer note, stored in the topic file" },
        topic: { type: "string", description: "Optional topic file name (e.g. 'auth', 'build')" },
      },
      required: ["summary"],
    } as any,
    execute: async (_id, params) => {
      const a = params as { summary: string; detail?: string; topic?: string };
      const r = S.saveMemory(a, cwd());
      const warn = r.indexCap.overLimit
        ? "WARNING: memory index is over the 200-line/25KB load limit — content past the limit will NOT load next session. Trim it (memory_edit) or move detail into topic files."
        : r.indexCap.nearLimit
          ? "Note: memory index is near the load limit — keep entries to one line."
          : undefined;
      return ok({ saved: true, wroteTopic: r.wroteTopic, cap: r.indexCap, warn });
    },
  });

  pi.registerTool({
    name: "memory_append",
    label: "Append Memory",
    description: "Append text to a topic file (detail notes, not the always-loaded index).",
    parameters: {
      type: "object",
      properties: { topic: { type: "string" }, text: { type: "string" } },
      required: ["topic", "text"],
    } as any,
    execute: async (_id, params) => {
      const a = params as { topic: string; text: string };
      return ok({ appended: S.appendTopic(a.topic, a.text, cwd()) });
    },
  });

  pi.registerTool({
    name: "memory_edit",
    label: "Edit Memory",
    description: "Replace a unique snippet in a memory file. `file` is a topic name or 'MEMORY.md'.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      },
      required: ["file", "oldText", "newText"],
    } as any,
    execute: async (_id, params) => {
      const a = params as { file: string; oldText: string; newText: string };
      S.editFile(a.file, a.oldText, a.newText, cwd());
      return ok({ edited: a.file });
    },
  });

  pi.registerTool({
    name: "memory_read",
    label: "Read Memory",
    description: "Read a memory file in full. `file` is a topic name or 'MEMORY.md'.",
    parameters: {
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"],
    } as any,
    execute: async (_id, params) => {
      const a = params as { file: string };
      return ok({ file: a.file, content: S.readMemoryFile(a.file, cwd()) });
    },
  });

  pi.registerTool({
    name: "memory_list",
    label: "List Memory",
    description: "List this project's memory files with sizes, plus the loaded index.",
    parameters: { type: "object", properties: {} } as any,
    execute: async () =>
      ok({
        dir: S.memoryDir(cwd()),
        files: S.listFiles(cwd()),
        index: S.readIndexTruncated(cwd()).text,
      }),
  });

  pi.registerTool({
    name: "recap",
    label: "Save Recap",
    description:
      "Save a one-line 'where you left off' recap of the current session to project memory. " +
      "Call this when asked to recap, or before a long pause, with a concise summary of what you " +
      "were doing and what's still pending.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string", description: "One-line recap of current state and next step" } },
      required: ["summary"],
    } as any,
    execute: async (_id, params) => {
      const a = params as { summary: string };
      S.appendRecap(a.summary, cwd());
      return ok({ saved: true });
    },
  });

  // ── Context injection: auto-load the memory index every turn ────────────────

  pi.on("before_agent_start", (event) => {
    const { text, truncated } = S.readIndexTruncated(cwd());
    let block = "";
    if (text.trim()) {
      block =
        `\n\n<project-memory>\n${text.trim()}\n</project-memory>\n` +
        (truncated ? "(memory index truncated to the load limit; use memory_read for topic files)\n" : "");
    }
    return {
      systemPrompt:
        event.systemPrompt +
        block +
        "\n\nWhen you learn a durable fact about this project (a build gotcha, a correction, a " +
        "convention, an architecture detail), call the `memory_save` tool so it persists to future sessions.",
    };
  });

  // ── Recap on resume: surface the last saved recap ───────────────────────────

  let recapShown = false;
  pi.on("session_start", (event) => {
    if (event.reason === "new" || event.reason === "startup") recapShown = false;
    if (event.reason !== "resume" || recapShown) return;
    const r = S.latestRecap(cwd());
    if (r) {
      recapShown = true;
      pi.sendMessage({ customType: "memory_recap", content: `⏺ Recap: ${r}`, display: true });
    }
  });

  // ── /recap command: on-demand summary ───────────────────────────────────────

  pi.registerCommand("recap", {
    description: "Summarize where you left off (one line) and save it to project memory",
    handler: async (args) => {
      const showLast = args.trim() === "last" || args.trim() === "show";
      if (showLast) {
        const r = S.latestRecap(cwd());
        pi.sendMessage({
          customType: "memory_recap",
          content: r ? `⏺ Recap: ${r}` : "No saved recap yet.",
          display: true,
        });
        return;
      }
      // Ask the model to produce + save a fresh recap.
      pi.sendUserMessage(
        "Give a one-line recap of where we left off — what you were doing and what's still pending — " +
          "then save it by calling the `recap` tool with that same one line. Keep it to a single sentence.",
      );
    },
  });

  // ── /memory command: browse the store ───────────────────────────────────────

  pi.registerCommand("memory", {
    description: "Show this project's memory files (browse/edit in the Memory panel or ask me to edit)",
    handler: async () => {
      try {
        const dir = S.memoryDir(cwd());
        const files = S.listFiles(cwd());
        const lines = files.length
          ? files.map((f) => `  ${f.file} — ${f.lines} lines, ${f.bytes} B`).join("\n")
          : "  (empty)";
        const { text } = S.readIndexTruncated(cwd());
        pi.sendMessage({
          customType: "memory_list",
          content:
            `Project memory: ${dir}\n${lines}` +
            (text.trim() ? `\n\nLoaded index:\n${text.trim()}` : ""),
          display: true,
        });
      } catch (e) {
        pi.sendMessage({
          customType: "memory_list",
          content: `Error reading memory: ${e instanceof Error ? e.message : String(e)}`,
          display: true,
        });
      }
    },
  });
};
