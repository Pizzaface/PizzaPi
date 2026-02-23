import * as React from "react";
import type { BundledLanguage } from "shiki";

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import { DiffView } from "@/components/ai-elements/diff-view";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  StatusBadge,
  type ToolPart,
} from "@/components/ai-elements/tool";

type ToolState = ToolPart["state"];
import {
  Terminal,
  TerminalHeader,
  TerminalTitle,
  TerminalStatus,
  TerminalActions,
  TerminalCopyButton,
  TerminalContent,
} from "@/components/ai-elements/terminal";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning";
import { FileTypeCard } from "@/components/ai-elements/file-type-card";
import { EditFileCard } from "@/components/ai-elements/edit-file-card";
import {
  estimateBase64Bytes,
  extractPathFromToolContent,
  extractTextFromToolContent,
  extToMime,
  formatBytes,
  formatDateValue,
  hasVisibleContent,
  normalizeToolName,
  parseToolInputArgs,
  tryParseJsonObject,
} from "@/components/session-viewer/utils";
import { ChevronDownIcon, ListTodoIcon, CircleDashedIcon, CircleDotIcon, CheckCircle2Icon, XCircleIcon as XCircleIcon2, TagIcon, WrenchIcon, RocketIcon, SendIcon, InboxIcon, ClockIcon, HashIcon, ExternalLinkIcon, MessageSquareIcon, Loader2Icon, BotIcon } from "lucide-react";
import {
  ToolCardShell,
  ToolCardHeader,
  ToolCardTitle,
  ToolCardActions,
  ToolCardSection,
  StatusPill,
} from "@/components/ui/tool-card";
import type { SubAgentTurn } from "@/components/session-viewer/types";

interface TodoItem {
  id: number;
  text: string;
  status: "pending" | "in_progress" | "done" | "cancelled";
}

function TodoCard({ todos }: { todos: TodoItem[] }) {
  const done = todos.filter((t) => t.status === "done").length;
  const total = todos.length;

  const statusIcon = (status: TodoItem["status"]) => {
    switch (status) {
      case "done":
        return <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-500" />;
      case "in_progress":
        return <CircleDotIcon className="size-3.5 shrink-0 text-blue-400 animate-pulse" />;
      case "cancelled":
        return <XCircleIcon2 className="size-3.5 shrink-0 text-zinc-500" />;
      default:
        return <CircleDashedIcon className="size-3.5 shrink-0 text-zinc-500" />;
    }
  };

  return (
    <ToolCardShell>
      <ToolCardHeader>
        <ToolCardTitle icon={<ListTodoIcon className="size-4 shrink-0 text-zinc-400" />}>
          <span className="text-sm font-medium text-zinc-400">Tasks</span>
        </ToolCardTitle>
        <span className="text-[11px] text-zinc-500 tabular-nums">
          {done}/{total} done
        </span>
      </ToolCardHeader>
      <ul className="divide-y divide-zinc-800/60">
        {todos.map((item) => (
          <li
            key={item.id}
            className={`flex items-start gap-2.5 px-4 py-2 ${
              item.status === "done" || item.status === "cancelled"
                ? "opacity-60"
                : ""
            }`}
          >
            <span className="mt-0.5">{statusIcon(item.status)}</span>
            <span
              className={`text-xs leading-relaxed ${
                item.status === "done"
                  ? "line-through text-zinc-500"
                  : item.status === "cancelled"
                    ? "line-through text-zinc-600"
                    : item.status === "in_progress"
                      ? "text-zinc-200"
                      : "text-zinc-400"
              }`}
            >
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    </ToolCardShell>
  );
}

function SessionNameCard({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-xs text-zinc-400">
      <TagIcon className="size-3.5 shrink-0 text-zinc-500" />
      <span>
        Session named <span className="font-medium text-zinc-200">{name}</span>
      </span>
    </div>
  );
}

// ── Inter-agent messaging cards ──────────────────────────────────────────────

function truncateSessionId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Parse the text result of spawn_session to extract structured details.
 */
function parseSpawnResult(text: string | null): {
  sessionId?: string;
  runnerId?: string;
  cwd?: string;
  model?: string;
  status?: string;
  shareUrl?: string;
  error?: string;
} {
  if (!text) return {};
  const result: Record<string, string> = {};
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Session ID:")) result.sessionId = trimmed.replace("Session ID:", "").trim();
    else if (trimmed.startsWith("Runner:")) result.runnerId = trimmed.replace("Runner:", "").trim();
    else if (trimmed.startsWith("Working directory:")) result.cwd = trimmed.replace("Working directory:", "").trim();
    else if (trimmed.startsWith("Model:")) result.model = trimmed.replace("Model:", "").trim();
    else if (trimmed.startsWith("Status:")) result.status = trimmed.replace("Status:", "").trim();
    else if (trimmed.startsWith("Web UI:")) result.shareUrl = trimmed.replace("Web UI:", "").trim();
    else if (trimmed.startsWith("Error")) result.error = trimmed;
  }
  return result;
}

function SpawnSessionCard({
  prompt,
  model,
  cwd,
  resultText,
  isStreaming,
}: {
  prompt: string;
  model?: { provider: string; id: string };
  cwd?: string;
  resultText: string | null;
  isStreaming: boolean;
}) {
  const parsed = parseSpawnResult(resultText);
  const isError = resultText?.startsWith("Error") ?? false;

  return (
    <ToolCardShell>
      <ToolCardHeader className="py-2.5">
        <ToolCardTitle icon={<RocketIcon className="size-3.5 shrink-0 text-violet-400" />}>
          <span className="text-sm font-medium text-zinc-300">Spawn Session</span>
        </ToolCardTitle>
        <ToolCardActions>
          {isStreaming ? (
            <StatusPill variant="streaming">Spawning…</StatusPill>
          ) : isError ? (
            <StatusPill variant="error">Failed</StatusPill>
          ) : resultText ? (
            <StatusPill variant="success">Spawned</StatusPill>
          ) : null}
        </ToolCardActions>
      </ToolCardHeader>

      {/* Prompt */}
      <ToolCardSection>
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-600">Prompt</div>
        <p className="whitespace-pre-wrap break-words text-zinc-300 leading-relaxed line-clamp-4">
          {prompt}
        </p>
      </ToolCardSection>

      {/* Meta row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-[11px] text-zinc-500">
        {model && (
          <span>
            <span className="text-zinc-600">Model:</span>{" "}
            <span className="text-zinc-400">{model.provider}/{model.id}</span>
          </span>
        )}
        {(cwd || parsed.cwd) && (
          <span className="truncate max-w-60">
            <span className="text-zinc-600">CWD:</span>{" "}
            <span className="font-mono text-zinc-400">{cwd || parsed.cwd}</span>
          </span>
        )}
        {parsed.sessionId && (
          <span>
            <span className="text-zinc-600">ID:</span>{" "}
            <span className="font-mono text-zinc-400">{truncateSessionId(parsed.sessionId)}</span>
          </span>
        )}
      </div>

      {/* Link to session */}
      {parsed.shareUrl && (
        <div className="border-t border-zinc-800/60 px-4 py-2">
          <a
            href={parsed.shareUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[11px] text-violet-400 hover:text-violet-300 transition-colors"
          >
            <ExternalLinkIcon className="size-3" />
            Open in Web UI
          </a>
        </div>
      )}

      {/* Error display */}
      {isError && resultText && (
        <div className="border-t border-red-800/30 bg-red-950/20 px-4 py-2 text-red-400">
          {resultText}
        </div>
      )}
    </ToolCardShell>
  );
}

function SendMessageCard({
  targetSessionId,
  message,
  resultText,
  isStreaming,
}: {
  targetSessionId: string;
  message: string;
  resultText: string | null;
  isStreaming: boolean;
}) {
  const isError = resultText?.startsWith("Error") ?? false;

  return (
    <ToolCardShell>
      <ToolCardHeader>
        <ToolCardTitle icon={<SendIcon className="size-3.5 shrink-0 text-blue-400" />}>
          <span className="text-sm font-medium text-zinc-300">Message Sent</span>
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
            → {truncateSessionId(targetSessionId)}
          </span>
        </ToolCardTitle>
        <div className="flex shrink-0 items-center gap-1.5">
          {isStreaming ? (
            <Loader2Icon className="size-3 animate-spin text-zinc-500" />
          ) : isError ? (
            <XCircleIcon2 className="size-3.5 text-red-400" />
          ) : resultText ? (
            <CheckCircle2Icon className="size-3.5 text-emerald-500" />
          ) : null}
        </div>
      </ToolCardHeader>

      {/* Message body */}
      <div className="px-4 py-3">
        <div className="rounded-lg rounded-br-sm bg-blue-600/15 border border-blue-500/20 px-3 py-2">
          <p className="whitespace-pre-wrap break-words text-zinc-200 leading-relaxed">
            {message}
          </p>
        </div>
      </div>

      {/* Error */}
      {isError && resultText && (
        <div className="border-t border-red-800/30 bg-red-950/20 px-4 py-2 text-red-400">
          {resultText}
        </div>
      )}
    </ToolCardShell>
  );
}

function WaitForMessageCard({
  fromSessionId,
  timeout,
  resultText,
  isStreaming,
}: {
  fromSessionId?: string;
  timeout?: number;
  resultText: string | null;
  isStreaming: boolean;
}) {
  const isTimedOut = resultText?.includes("No message received") ?? false;
  const isCancelled = resultText === "Wait was cancelled.";
  const hasMessage = resultText?.startsWith("Message from session") ?? false;

  // Parse received message
  let senderSessionId: string | null = null;
  let receivedMessage: string | null = null;
  if (hasMessage && resultText) {
    const match = resultText.match(/^Message from session (.+?):\n\n([\s\S]*)$/);
    if (match) {
      senderSessionId = match[1];
      receivedMessage = match[2];
    }
  }

  return (
    <ToolCardShell>
      <ToolCardHeader>
        <ToolCardTitle icon={<InboxIcon className="size-3.5 shrink-0 text-amber-400" />}>
          <span className="text-sm font-medium text-zinc-300">
            {isStreaming ? "Waiting for Message" : hasMessage ? "Message Received" : "Wait for Message"}
          </span>
          {fromSessionId && (
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
              ← {truncateSessionId(fromSessionId)}
            </span>
          )}
          {!fromSessionId && !senderSessionId && (
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-600">
              any session
            </span>
          )}
        </ToolCardTitle>
        <ToolCardActions>
          {isStreaming && (
            <StatusPill variant="info" icon={<Loader2Icon className="size-3 animate-spin" />}>
              Listening…
            </StatusPill>
          )}
          {isTimedOut && (
            <StatusPill variant="neutral" icon={<ClockIcon className="size-3" />}>
              Timed out
            </StatusPill>
          )}
          {isCancelled && (
            <StatusPill variant="neutral">Cancelled</StatusPill>
          )}
        </ToolCardActions>
      </ToolCardHeader>

      {/* Received message */}
      {hasMessage && receivedMessage !== null && (
        <div className="px-4 py-3">
          {senderSessionId && (
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-zinc-500">
              <MessageSquareIcon className="size-3 shrink-0" />
              <span className="font-mono">{truncateSessionId(senderSessionId)}</span>
            </div>
          )}
          <div className="rounded-lg rounded-bl-sm bg-amber-500/10 border border-amber-500/20 px-3 py-2">
            <p className="whitespace-pre-wrap break-words text-zinc-200 leading-relaxed">
              {receivedMessage}
            </p>
          </div>
        </div>
      )}

      {/* Waiting state */}
      {isStreaming && !hasMessage && (
        <div className="flex items-center justify-center gap-2 px-4 py-6 text-zinc-500">
          <Loader2Icon className="size-4 animate-spin" />
          <span>Waiting for a message{fromSessionId ? ` from ${truncateSessionId(fromSessionId)}` : ""}…</span>
          {timeout && <span className="text-zinc-600">({timeout}s timeout)</span>}
        </div>
      )}

      {/* Timed out / cancelled */}
      {(isTimedOut || isCancelled) && (
        <div className="px-4 py-3 text-zinc-500">
          {resultText}
        </div>
      )}
    </ToolCardShell>
  );
}

function CheckMessagesCard({
  fromSessionId,
  resultText,
  isStreaming,
}: {
  fromSessionId?: string;
  resultText: string | null;
  isStreaming: boolean;
}) {
  const isEmpty = resultText === "No pending messages.";

  // Parse multiple messages from result
  const parsedMessages: Array<{ fromSessionId: string; message: string }> = [];
  if (resultText && !isEmpty) {
    const body = resultText.replace(/^\d+ message\(s\) received:\n\n/, "");
    const parts = body.split(/\n\n(?=\[)/);
    for (const part of parts) {
      const match = part.match(/^\[(.+?)\]\s([\s\S]*)$/);
      if (match) {
        parsedMessages.push({ fromSessionId: match[1], message: match[2] });
      }
    }
  }

  return (
    <ToolCardShell>
      <ToolCardHeader>
        <ToolCardTitle icon={<InboxIcon className="size-3.5 shrink-0 text-teal-400" />}>
          <span className="text-sm font-medium text-zinc-300">Check Messages</span>
          {fromSessionId && (
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
              from {truncateSessionId(fromSessionId)}
            </span>
          )}
        </ToolCardTitle>
        <ToolCardActions>
          {isStreaming ? (
            <Loader2Icon className="size-3 animate-spin text-zinc-500" />
          ) : parsedMessages.length > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-teal-800/60 bg-teal-900/30 px-2 py-0.5 text-[11px] text-teal-400">
              {parsedMessages.length} message{parsedMessages.length !== 1 ? "s" : ""}
            </span>
          ) : resultText ? (
            <span className="text-[11px] text-zinc-600">Empty</span>
          ) : null}
        </ToolCardActions>
      </ToolCardHeader>

      {/* Messages */}
      {parsedMessages.length > 0 && (
        <div className="divide-y divide-zinc-800/60">
          {parsedMessages.map((msg, i) => (
            <div key={i} className="px-4 py-2.5">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] text-zinc-500">
                <MessageSquareIcon className="size-3 shrink-0" />
                <span className="font-mono">{truncateSessionId(msg.fromSessionId)}</span>
              </div>
              <div className="rounded-lg rounded-bl-sm bg-teal-500/10 border border-teal-500/20 px-3 py-2">
                <p className="whitespace-pre-wrap break-words text-zinc-200 leading-relaxed">
                  {msg.message}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {isEmpty && (
        <div className="flex items-center justify-center gap-2 px-4 py-4 text-zinc-600">
          <InboxIcon className="size-3.5" />
          <span>No pending messages</span>
        </div>
      )}
    </ToolCardShell>
  );
}

function GetSessionIdCard({ sessionId }: { sessionId: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-xs text-zinc-400">
      <HashIcon className="size-3.5 shrink-0 text-zinc-500" />
      <span>
        Session ID: <span className="font-mono font-medium text-zinc-200">{sessionId}</span>
      </span>
    </div>
  );
}

function CopyableCodeBlock({
  code,
  language,
  className,
  filename,
}: {
  code: string;
  language: BundledLanguage | string;
  className?: string;
  filename?: string;
}) {
  return (
    <CodeBlock code={code} language={language as BundledLanguage} className={className}>
      <CodeBlockHeader>
        <CodeBlockTitle>
          {filename ? (
            <CodeBlockFilename>{filename}</CodeBlockFilename>
          ) : (
            <span className="text-xs">{language}</span>
          )}
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
}

function WriteFileCard({
  path,
  content,
}: {
  path: string;
  content: string;
}) {
  const lineCount = content ? content.split("\n").length : 0;
  const lang = extToLang(path);
  return (
    <EditFileCard path={path} additions={lineCount} deletions={0}>
      <CopyableCodeBlock code={content} language={lang} className="border-0 rounded-none" />
    </EditFileCard>
  );
}

export function toMessageRole(role: string): "user" | "assistant" | "system" {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "system") return "system";
  return "assistant";
}

export function roleLabel(role: string) {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "toolResult") return "Tool";
  return role || "Message";
}

function extToLang(path: string): BundledLanguage {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, BundledLanguage> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    cs: "csharp",
    rb: "ruby",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    html: "html",
    css: "css",
    toml: "toml",
    sql: "sql",
  };
  return map[ext] ?? "markdown";
}

function metadataBadge(label: string, value: string) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border/70 bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
      <span className="opacity-70">{label}:</span>
      <span className="font-mono text-foreground/90">{value}</span>
    </span>
  );
}

function renderReadToolResult(
  content: unknown,
  isError?: boolean,
  toolInput?: unknown
) {
  const text = extractTextFromToolContent(content);
  const defaultPath =
    extractPathFromToolContent(content) ??
    (() => {
      if (toolInput && typeof toolInput === "object") {
        const inp = toolInput as Record<string, unknown>;
        return typeof inp.file_path === "string"
          ? inp.file_path
          : typeof inp.path === "string"
            ? inp.path
            : undefined;
      }
      return undefined;
    })();

  const blocks = Array.isArray(content)
    ? content.filter(
        (block): block is Record<string, unknown> =>
          !!block && typeof block === "object"
      )
    : content && typeof content === "object"
      ? [content as Record<string, unknown>]
      : [];

  const imageBlocks = blocks.filter((block) => {
    const mimeType =
      typeof block.mimeType === "string"
        ? block.mimeType
        : typeof block.mime === "string"
          ? block.mime
          : "";
    return (
      (block.type === "image" || mimeType.startsWith("image/")) &&
      typeof block.data === "string"
    );
  });

  const resolvedPath = (() => {
    const parsed = text ? tryParseJsonObject(text.trim()) : null;
    if (parsed && typeof parsed.path === "string") return parsed.path;
    return defaultPath;
  })();

  const resolvedCode = (() => {
    if (!text) return null;
    const parsed = tryParseJsonObject(text.trim());
    if (parsed && typeof parsed.content === "string") return parsed.content;
    return text;
  })();

  const fileName = resolvedPath
    ? resolvedPath.split(/[\\/]/).filter(Boolean).pop() ?? resolvedPath
    : null;

  const mimeType = resolvedPath ? extToMime(resolvedPath) : "text/plain";
  const lang = resolvedPath ? extToLang(resolvedPath) : "markdown";

  const textCard = resolvedCode ? (
    <FileTypeCard
      path={resolvedPath ?? "file"}
      fileName={fileName ?? "file"}
      mimeType={mimeType}
      className={isError ? "border-destructive/60" : undefined}
    >
      <CopyableCodeBlock code={resolvedCode} language={lang} className="border-0 rounded-none" />
    </FileTypeCard>
  ) : null;

  const imageNodes = imageBlocks.map((block, idx) => {
    const path = typeof block.path === "string" ? block.path : defaultPath;
    const imgMime =
      typeof block.mimeType === "string"
        ? block.mimeType
        : typeof block.mime === "string"
          ? block.mime
          : "image/png";
    const data = block.data as string;
    const width =
      typeof block.width === "number"
        ? block.width
        : typeof block.pixelWidth === "number"
          ? block.pixelWidth
          : null;
    const height =
      typeof block.height === "number"
        ? block.height
        : typeof block.pixelHeight === "number"
          ? block.pixelHeight
          : null;

    const explicitSize =
      typeof block.sizeBytes === "number"
        ? block.sizeBytes
        : typeof block.byteLength === "number"
          ? block.byteLength
          : typeof block.size === "number"
            ? block.size
            : null;

    const sizeBytes = explicitSize ?? estimateBase64Bytes(data);

    const mtimeRaw =
      block.mtime ??
      block.mtimeMs ??
      block.lastModified ??
      block.updatedAt;
    const mtime = formatDateValue(mtimeRaw);

    const title = path
      ? path.split(/[\\/]/).filter(Boolean).pop() ?? path
      : `Image ${idx + 1}`;

    return (
      <FileTypeCard
        key={`${title}-${idx}`}
        path={path ?? `image-${idx + 1}`}
        fileName={title}
        mimeType={imgMime}
      >
        <div className="space-y-2 p-3">
          <div className="flex flex-wrap gap-1.5">
            {metadataBadge("size", formatBytes(sizeBytes))}
            {width && height
              ? metadataBadge("dimensions", `${width}×${height}`)
              : null}
            {mtime ? metadataBadge("mtime", mtime) : null}
          </div>
          <img
            src={`data:${imgMime};base64,${data}`}
            alt={title}
            className="max-w-full rounded border border-border/70 bg-background object-contain"
          />
        </div>
      </FileTypeCard>
    );
  });

  if (!textCard && imageNodes.length === 0) {
    return (
      <CopyableCodeBlock
        code={JSON.stringify(content, null, 2)}
        language="json"
        className="border-border/70"
      />
    );
  }

  return (
    <div className="space-y-2">
      {textCard}
      {imageNodes}
    </div>
  );
}

function renderToolResult(content: unknown, toolName?: string, isError?: boolean) {
  const normalizedToolName = normalizeToolName(toolName);

  if (normalizedToolName === "read" || normalizedToolName.endsWith(".read")) {
    return renderReadToolResult(content, isError);
  }

  const text = extractTextFromToolContent(content);

  if (normalizedToolName === "bash" || normalizedToolName.endsWith(".bash")) {
    if (text) {
      return <Terminal output={text} isStreaming={false} className="text-xs" />;
    }
  }

  if (normalizedToolName === "edit" || normalizedToolName.endsWith(".edit")) {
    const parsed = text ? tryParseJsonObject(text.trim()) : null;
    const asObj =
      content && typeof content === "object" && !Array.isArray(content)
        ? (content as Record<string, unknown>)
        : parsed;

    const path = asObj && typeof asObj.path === "string" ? asObj.path : null;
    const oldText =
      asObj && typeof asObj.oldText === "string" ? asObj.oldText : null;
    const newText =
      asObj && typeof asObj.newText === "string" ? asObj.newText : null;

    if (path && oldText !== null && newText !== null) {
      return <DiffView path={path} oldText={oldText} newText={newText} />;
    }

    if (text && /^successfully\s+replaced\s+text/i.test(text.trim())) {
      return null;
    }

    if (text) {
      return (
        <CopyableCodeBlock code={text} language="markdown" className="border-border/70" />
      );
    }
  }

  if (
    normalizedToolName === "write" ||
    normalizedToolName.endsWith(".write") ||
    normalizedToolName === "write_file" ||
    normalizedToolName.endsWith(".write_file")
  ) {
    const parsed = text ? tryParseJsonObject(text.trim()) : null;
    const asObj =
      content && typeof content === "object" && !Array.isArray(content)
        ? (content as Record<string, unknown>)
        : parsed;

    const path = asObj && typeof asObj.path === "string" ? asObj.path : null;
    const newText =
      asObj && typeof asObj.content === "string" ? asObj.content : null;

    if (path && newText !== null) {
      return <WriteFileCard path={path} content={newText} />;
    }

    if (text) {
      return (
        <CopyableCodeBlock code={text} language="markdown" className="border-border/70" />
      );
    }
  }

  if (text) {
    const trimmed = text.trim();
    const parsed = tryParseJsonObject(trimmed);
    if (parsed) {
      return (
        <CopyableCodeBlock
          code={JSON.stringify(parsed, null, 2)}
          language="json"
          className="border-border/70"
        />
      );
    }

    if (trimmed.includes("\n") || trimmed.length > 100) {
      return (
        <CopyableCodeBlock code={text} language="markdown" className="border-border/70" />
      );
    }

    return <MessageResponse>{text}</MessageResponse>;
  }

  if (content === undefined || content === null) return null;

  return (
    <CopyableCodeBlock
      code={JSON.stringify(content, null, 2)}
      language="json"
      className="border-border/70"
    />
  );
}

function synthesizeCommandLine(toolName: string, toolInput: unknown): string {
  const norm = normalizeToolName(toolName);
  const shortName = toolName.includes(".") ? toolName.split(".").pop()! : toolName;

  if (!toolInput || typeof toolInput !== "object") return shortName;
  const args = toolInput as Record<string, unknown>;

  if (norm === "bash" || norm.endsWith(".bash")) {
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    return cmd || shortName;
  }

  for (const key of ["file_path", "path", "command", "query", "url", "name"]) {
    if (typeof args[key] === "string" && args[key]) {
      return `${shortName} ${args[key] as string}`;
    }
  }

  return shortName;
}

function renderGroupedToolExecution(
  toolKey: string,
  toolName: string,
  toolInput: unknown,
  content: unknown,
  isError: boolean | undefined,
  isStreaming: boolean,
  thinking?: string,
  thinkingDuration?: number
) {
  const hasOutput = hasVisibleContent(content);
  const state: ToolState = hasOutput
    ? isError
      ? "output-error"
      : "output-available"
    : isStreaming
      ? "input-streaming"
      : "input-available";

  const norm = normalizeToolName(toolName);
  let card: React.ReactNode = null;

  if (norm === "bash" || norm.endsWith(".bash")) {
    const commandLine = synthesizeCommandLine(toolName, toolInput);
    const outputText = hasOutput ? extractTextFromToolContent(content) : null;
    card = (
      <ToolCardShell className="flex flex-col">
        <ToolCardHeader>
          <ToolCardTitle icon={null}>
            <span className="text-sm text-zinc-400"><TerminalTitle>{toolName}</TerminalTitle></span>
          </ToolCardTitle>
          <ToolCardActions><StatusBadge status={state} /></ToolCardActions>
        </ToolCardHeader>
        <div className="px-4 py-2 font-mono text-xs border-b border-zinc-800">
          <span className="text-zinc-600 select-none mr-1">$</span>
          <span className="text-zinc-300 whitespace-pre-wrap break-all">
            {commandLine}
          </span>
        </div>
        {(hasOutput || isStreaming) && (
          <Terminal
            output={outputText ?? ""}
            isStreaming={isStreaming}
            className="rounded-none border-0"
          >
            <details open={isStreaming || undefined} className="flex flex-col">
              <summary className="cursor-pointer list-none">
                <div className="flex items-center justify-between gap-2 px-4 py-1.5 border-b border-zinc-800 hover:bg-zinc-900 transition-colors">
                  <span className="text-[11px] text-zinc-500 select-none">
                    Output
                  </span>
                  <div className="flex items-center gap-2">
                    <TerminalStatus />
                    <TerminalActions>
                      {outputText && <TerminalCopyButton />}
                    </TerminalActions>
                    <ChevronDownIcon className="size-3 text-zinc-600 transition-transform [[open]_&]:rotate-180" />
                  </div>
                </div>
              </summary>
              <TerminalContent className="text-xs" />
            </details>
          </Terminal>
        )}
      </ToolCardShell>
    );
  } else if (norm === "read" || norm.endsWith(".read")) {
    if (hasOutput) {
      card = renderReadToolResult(content, isError, toolInput);
    } else {
      const inputArgs = parseToolInputArgs(toolInput);
      const pendingPath =
        typeof inputArgs.file_path === "string"
          ? inputArgs.file_path
          : typeof inputArgs.path === "string"
            ? inputArgs.path
            : "file";
      const pendingName = pendingPath.split(/[\\/]/).filter(Boolean).pop() ?? "file";
      const pendingMime = extToMime(pendingPath);
      card = (
        <FileTypeCard path={pendingPath} fileName={pendingName} mimeType={pendingMime}>
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            {isStreaming ? "Reading file…" : "No content"}
          </div>
        </FileTypeCard>
      );
    }
  } else if (norm === "edit" || norm.endsWith(".edit")) {
    const inputArgs = parseToolInputArgs(toolInput);
    const resultText = hasOutput ? extractTextFromToolContent(content) : null;
    const resultObj = resultText ? tryParseJsonObject(resultText.trim()) : null;
    const contentObj =
      content && typeof content === "object" && !Array.isArray(content)
        ? (content as Record<string, unknown>)
        : resultObj;

    const editPath =
      typeof inputArgs.file_path === "string"
        ? inputArgs.file_path
        : typeof inputArgs.path === "string"
          ? inputArgs.path
          : contentObj && typeof contentObj.path === "string"
            ? contentObj.path
            : null;
    const oldText =
      typeof inputArgs.old_string === "string"
        ? inputArgs.old_string
        : typeof inputArgs.oldText === "string"
          ? inputArgs.oldText
          : contentObj && typeof contentObj.oldText === "string"
            ? contentObj.oldText
            : null;
    const newText =
      typeof inputArgs.new_string === "string"
        ? inputArgs.new_string
        : typeof inputArgs.newText === "string"
          ? inputArgs.newText
          : contentObj && typeof contentObj.newText === "string"
            ? contentObj.newText
            : null;

    if (editPath && oldText !== null && newText !== null) {
      card = <DiffView path={editPath} oldText={oldText} newText={newText} />;
    } else {
      const pendingPath = editPath ?? "file";
      const pendingName = pendingPath.split(/[\\/]/).filter(Boolean).pop() ?? "file";
      card = (
        <EditFileCard
          path={pendingPath}
          fileName={pendingName}
          additions={0}
          deletions={0}
        >
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            {isStreaming
              ? "Applying edit…"
              : hasOutput
                ? resultText ?? "Edit complete"
                : "No diff available"}
          </div>
        </EditFileCard>
      );
    }
  } else if (
    norm === "write" ||
    norm.endsWith(".write") ||
    norm === "write_file" ||
    norm.endsWith(".write_file")
  ) {
    const inputArgs = parseToolInputArgs(toolInput);

    const writePath =
      typeof inputArgs.file_path === "string"
        ? inputArgs.file_path
        : typeof inputArgs.path === "string"
          ? inputArgs.path
          : null;
    const newText =
      typeof inputArgs.content === "string"
        ? inputArgs.content
        : typeof inputArgs.newText === "string"
          ? inputArgs.newText
          : null;

    if (writePath && newText !== null) {
      card = <WriteFileCard path={writePath} content={newText} />;
    } else {
      const resultText = hasOutput ? extractTextFromToolContent(content) : null;
      const pendingPath = writePath ?? "file";
      const pendingName = pendingPath.split(/[\\/]/).filter(Boolean).pop() ?? "file";
      card = (
        <EditFileCard
          path={pendingPath}
          fileName={pendingName}
          additions={0}
          deletions={0}
        >
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            {isStreaming
              ? "Writing file…"
              : hasOutput
                ? resultText ?? "Write complete"
                : "No diff available"}
          </div>
        </EditFileCard>
      );
    }
  } else if (norm === "update_todo" || norm.endsWith(".update_todo")) {
    // Todo list — render as a checklist card from the tool input
    const inputArgs = parseToolInputArgs(toolInput);
    const todos = Array.isArray(inputArgs.todos) ? (inputArgs.todos as TodoItem[]) : [];
    if (todos.length > 0) {
      card = <TodoCard todos={todos} />;
    } else {
      // Empty or unparseable — hide
      card = null;
    }
  } else if (norm === "set_session_name" || norm.endsWith(".set_session_name")) {
    // Session name — render as a small inline badge
    const inputArgs = parseToolInputArgs(toolInput);
    const name = typeof inputArgs.name === "string" ? inputArgs.name : null;
    if (name) {
      card = <SessionNameCard name={name} />;
    } else {
      card = null;
    }
  } else if (norm === "spawn_session" || norm.endsWith(".spawn_session")) {
    const inputArgs = parseToolInputArgs(toolInput);
    const prompt = typeof inputArgs.prompt === "string" ? inputArgs.prompt : "";
    const model =
      inputArgs.model && typeof inputArgs.model === "object"
        ? (inputArgs.model as { provider: string; id: string })
        : undefined;
    const cwd = typeof inputArgs.cwd === "string" ? inputArgs.cwd : undefined;
    const resultText = hasOutput ? extractTextFromToolContent(content) : null;

    card = (
      <SpawnSessionCard
        prompt={prompt}
        model={model}
        cwd={cwd}
        resultText={resultText}
        isStreaming={isStreaming}
      />
    );
  } else if (norm === "send_message" || norm.endsWith(".send_message")) {
    const inputArgs = parseToolInputArgs(toolInput);
    const targetSessionId = typeof inputArgs.sessionId === "string" ? inputArgs.sessionId : "unknown";
    const message = typeof inputArgs.message === "string" ? inputArgs.message : "";
    const resultText = hasOutput ? extractTextFromToolContent(content) : null;

    card = (
      <SendMessageCard
        targetSessionId={targetSessionId}
        message={message}
        resultText={resultText}
        isStreaming={isStreaming}
      />
    );
  } else if (norm === "wait_for_message" || norm.endsWith(".wait_for_message")) {
    const inputArgs = parseToolInputArgs(toolInput);
    const fromSessionId = typeof inputArgs.fromSessionId === "string" ? inputArgs.fromSessionId : undefined;
    const timeout = typeof inputArgs.timeout === "number" ? inputArgs.timeout : undefined;
    const resultText = hasOutput ? extractTextFromToolContent(content) : null;

    card = (
      <WaitForMessageCard
        fromSessionId={fromSessionId}
        timeout={timeout}
        resultText={resultText}
        isStreaming={isStreaming}
      />
    );
  } else if (norm === "check_messages" || norm.endsWith(".check_messages")) {
    const inputArgs = parseToolInputArgs(toolInput);
    const fromSessionId = typeof inputArgs.fromSessionId === "string" ? inputArgs.fromSessionId : undefined;
    const resultText = hasOutput ? extractTextFromToolContent(content) : null;

    card = (
      <CheckMessagesCard
        fromSessionId={fromSessionId}
        resultText={resultText}
        isStreaming={isStreaming}
      />
    );
  } else if (norm === "get_session_id" || norm.endsWith(".get_session_id")) {
    const resultText = hasOutput ? extractTextFromToolContent(content) : null;
    const sessionId = resultText?.replace("This session's ID: ", "").trim() ?? null;

    if (sessionId && !resultText?.startsWith("Not connected")) {
      card = <GetSessionIdCard sessionId={sessionId} />;
    } else if (isStreaming) {
      card = (
        <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-xs text-zinc-500">
          <Loader2Icon className="size-3.5 animate-spin" />
          <span>Getting session ID…</span>
        </div>
      );
    } else {
      card = resultText ? (
        <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-xs text-red-400">
          <XCircleIcon2 className="size-3.5" />
          <span>{resultText}</span>
        </div>
      ) : null;
    }
  } else {
    // Default / Generic tool card
    const outputText = hasOutput ? extractTextFromToolContent(content) : null;
    const inputArgs =
      toolInput && typeof toolInput === "object"
        ? (toolInput as Record<string, unknown>)
        : null; // null (not {}) so we can skip rendering when there's no input

    // Pick the most descriptive arg value as a subtitle
    const subtitle = (() => {
      if (!inputArgs) return null;
      for (const key of ["file_path", "path", "command", "query", "url", "name", "ref", "text", "input"]) {
        const v = inputArgs[key];
        if (typeof v === "string" && v.trim()) {
          const trimmed = v.trim();
          return trimmed.length > 120 ? trimmed.slice(0, 117) + "…" : trimmed;
        }
      }
      return null;
    })();

    // Short display name: strip MCP prefix for readability
    const displayName = toolName.includes(".")
      ? toolName.split(".").pop()!
      : toolName;

    card = (
      <ToolCardShell>
        <ToolCardHeader className="py-2.5">
          <ToolCardTitle icon={<WrenchIcon className="size-3.5 shrink-0 text-zinc-500" />}>
            <span className="text-sm font-medium text-zinc-300 truncate">{displayName}</span>
            {toolName.includes(".") && (
              <span className="text-[10px] text-zinc-600 font-mono truncate hidden sm:inline">
                {toolName.split(".").slice(0, -1).join(".")}
              </span>
            )}
          </ToolCardTitle>
          <ToolCardActions>
            <StatusBadge status={state} />
          </ToolCardActions>
        </ToolCardHeader>

        {/* Subtitle — key argument */}
        {subtitle && (
          <div className="px-4 py-1.5 border-b border-zinc-800/60">
            <span className="text-xs text-zinc-400 font-mono break-all line-clamp-2">{subtitle}</span>
          </div>
        )}

        {/* Input args (collapsible) */}
        {inputArgs && Object.keys(inputArgs).length > 0 && (
          <details className="group/params">
            <summary className="cursor-pointer list-none">
              <div className="flex items-center justify-between gap-2 px-4 py-1.5 border-b border-zinc-800/60 hover:bg-zinc-900 transition-colors">
                <span className="text-[11px] text-zinc-500 select-none">Parameters</span>
                <ChevronDownIcon className="size-3 text-zinc-600 transition-transform group-open/params:rotate-180" />
              </div>
            </summary>
            <div className="border-b border-zinc-800/60">
              <CopyableCodeBlock
                code={JSON.stringify(inputArgs, null, 2)}
                language="json"
                className="border-0 rounded-none"
              />
            </div>
          </details>
        )}

        {/* Output (collapsible) */}
        {(hasOutput || isStreaming) && (
          <details open={isStreaming || undefined} className="group/output">
            <summary className="cursor-pointer list-none">
              <div className="flex items-center justify-between gap-2 px-4 py-1.5 hover:bg-zinc-900 transition-colors">
                <span className="text-[11px] text-zinc-500 select-none">
                  {isError ? "Error" : "Output"}
                </span>
                <ChevronDownIcon className="size-3 text-zinc-600 transition-transform group-open/output:rotate-180" />
              </div>
            </summary>
            {outputText ? (
              <CopyableCodeBlock
                code={outputText}
                language="markdown"
                className="border-0 rounded-none"
              />
            ) : (
              <div className="px-4 py-3 text-xs text-zinc-500">
                {isStreaming ? "Running…" : "No output"}
              </div>
            )}
          </details>
        )}
      </ToolCardShell>
    );
  }

  if (thinking) {
    return (
      <div className="flex flex-col gap-2">
         <div className="px-1">
            <Reasoning duration={thinkingDuration}>
               <ReasoningTrigger />
               <ReasoningContent>{thinking}</ReasoningContent>
            </Reasoning>
         </div>
         {card}
      </div>
    );
  }

  return card;
}

// ── Sub-agent conversation chat component ────────────────────────────────────

function SubAgentTurnBubble({ turn }: { turn: SubAgentTurn }) {
  if (turn.type === "sent") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="text-[10px] text-zinc-500 pr-1">
          → {truncateSessionId(turn.sessionId)}
          {turn.isError && <span className="text-red-400 ml-1">error</span>}
        </div>
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600/25 border border-blue-500/30 px-3 py-2 text-zinc-200 whitespace-pre-wrap break-words leading-relaxed text-[0.8rem]">
          {turn.message || <span className="italic text-zinc-500">(empty)</span>}
        </div>
        {turn.isStreaming && (
          <div className="flex items-center gap-1 text-[10px] text-zinc-500 pr-1">
            <Loader2Icon className="size-2.5 animate-spin" /> Sending…
          </div>
        )}
      </div>
    );
  }

  if (turn.type === "received") {
    return (
      <div className="flex flex-col items-start gap-1">
        <div className="text-[10px] text-zinc-500 pl-1">
          ← {truncateSessionId(turn.fromSessionId)}
        </div>
        <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-emerald-600/15 border border-emerald-500/25 px-3 py-2 text-zinc-200 whitespace-pre-wrap break-words leading-relaxed text-[0.8rem]">
          {turn.message}
        </div>
      </div>
    );
  }

  if (turn.type === "waiting") {
    if (turn.isTimedOut) {
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 pl-1">
          <ClockIcon className="size-3 shrink-0" />
          Timed out
          {turn.fromSessionId ? ` · from ${truncateSessionId(turn.fromSessionId)}` : ""}
        </div>
      );
    }
    if (turn.isCancelled) {
      return <div className="text-[11px] text-zinc-600 pl-1">Wait cancelled</div>;
    }
    // Actively waiting — show animated dots
    return (
      <div className="flex flex-col items-start gap-1">
        {turn.fromSessionId && (
          <div className="text-[10px] text-zinc-500 pl-1">
            ← {truncateSessionId(turn.fromSessionId)}
          </div>
        )}
        <div className="flex items-center gap-2.5 rounded-2xl rounded-bl-sm border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 text-zinc-500 text-[0.8rem]">
          <span className="inline-flex gap-1 items-end">
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:300ms]" />
          </span>
          {turn.timeout ? (
            <span className="text-[10px] text-zinc-600">{turn.timeout}s timeout</span>
          ) : null}
        </div>
      </div>
    );
  }

  if (turn.type === "check") {
    if (turn.isStreaming) {
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 pl-1">
          <Loader2Icon className="size-3 animate-spin" /> Checking messages…
        </div>
      );
    }
    if (turn.isEmpty) {
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-600 pl-1">
          <InboxIcon className="size-3 shrink-0" /> No pending messages
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-1.5">
        {turn.messages.map((m, idx) => (
          <div key={idx} className="flex flex-col items-start gap-1">
            <div className="text-[10px] text-zinc-500 pl-1">
              ← {truncateSessionId(m.fromSessionId)}
            </div>
            <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-teal-600/15 border border-teal-500/25 px-3 py-2 text-zinc-200 whitespace-pre-wrap break-words leading-relaxed text-[0.8rem]">
              {m.message}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return null;
}

function SubAgentConversationCard({ turns }: { turns: SubAgentTurn[] }) {
  // Collect unique remote session IDs for the header
  const sessionIds = new Set<string>();
  for (const turn of turns) {
    if (turn.type === "sent") sessionIds.add(turn.sessionId);
    else if (turn.type === "received") sessionIds.add(turn.fromSessionId);
    else if (turn.type === "waiting" && turn.fromSessionId) sessionIds.add(turn.fromSessionId);
    else if (turn.type === "check") {
      if (turn.fromSessionId) sessionIds.add(turn.fromSessionId);
      for (const m of turn.messages) sessionIds.add(m.fromSessionId);
    }
  }

  const lastTurn = turns.at(-1);
  const isActive =
    lastTurn &&
    ((lastTurn.type === "waiting" && lastTurn.isStreaming) ||
      (lastTurn.type === "sent" && lastTurn.isStreaming) ||
      (lastTurn.type === "check" && lastTurn.isStreaming));

  return (
    <ToolCardShell className="border-zinc-700/80">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <BotIcon className="size-3.5 shrink-0 text-violet-400" />
        <span className="text-[0.8rem] font-semibold text-zinc-300">Sub-agent</span>
        <div className="flex flex-wrap gap-1 min-w-0">
          {[...sessionIds].map((id) => (
            <span
              key={id}
              className="font-mono text-[10px] text-zinc-400 rounded bg-zinc-800 px-1.5 py-0.5"
            >
              {truncateSessionId(id)}
            </span>
          ))}
        </div>
        {isActive && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-violet-400 shrink-0">
            <Loader2Icon className="size-2.5 animate-spin" />
            Active
          </span>
        )}
      </div>

      {/* Chat bubbles */}
      <div className="flex flex-col gap-3 px-3 py-3 max-h-[28rem] overflow-y-auto">
        {turns.map((turn, i) => (
          <SubAgentTurnBubble key={i} turn={turn} />
        ))}
      </div>
    </ToolCardShell>
  );
}

export function renderContent(
  content: unknown,
  activeToolCalls: Map<string, string> | undefined,
  role: string | undefined,
  toolName: string | undefined,
  isError: boolean | undefined,
  toolInput: unknown,
  toolKey: string,
  isThinkingActive?: boolean,
  thinking?: string,
  thinkingDuration?: number,
  subAgentTurns?: SubAgentTurn[]
) {
  // Sub-agent conversation: render as a chat window
  if (role === "subAgentConversation" && subAgentTurns && subAgentTurns.length > 0) {
    return <SubAgentConversationCard turns={subAgentTurns} />;
  }

  if (role === "toolResult" || role === "tool") {
    if (toolInput !== undefined) {
      const isStreaming =
        !hasVisibleContent(content) &&
        (toolKey ? (activeToolCalls?.has(toolKey) ?? false) : false);
      return renderGroupedToolExecution(
        toolKey,
        toolName ?? "tool",
        toolInput,
        content,
        isError,
        isStreaming,
        thinking,
        thinkingDuration
      );
    }
    return renderToolResult(content, toolName, isError);
  }

  if (typeof content === "string") {
    return <MessageResponse>{content}</MessageResponse>;
  }

  if (Array.isArray(content)) {
    return (
      <div className="flex flex-col gap-2">
        {content.map((block, i) => {
          if (!block || typeof block !== "object") {
            return (
              <pre
                key={i}
                className="text-xs bg-muted/60 rounded p-2 overflow-x-auto"
              >
                {JSON.stringify(block, null, 2)}
              </pre>
            );
          }

          const b = block as Record<string, unknown>;

          if (b.type === "text") {
            return (
              <MessageResponse key={i}>
                {typeof b.text === "string" ? b.text : ""}
              </MessageResponse>
            );
          }

          if (b.type === "thinking") {
            const isLastBlock = i === (content as unknown[]).length - 1;
            const thinkingIsStreaming = isLastBlock && (isThinkingActive ?? false);
            const thinkingDuration = typeof b.durationSeconds === "number" ? b.durationSeconds : undefined;
            const thinkingText = typeof b.thinking === "string" ? b.thinking : "";
            // While streaming, strip trailing backticks so Streamdown doesn't
            // eagerly flush an incomplete inline-code or code-fence token.
            const displayText = thinkingIsStreaming ? thinkingText.replace(/`+$/, "") : thinkingText;
            return (
              <Reasoning key={i} isStreaming={thinkingIsStreaming} duration={thinkingDuration}>
                <ReasoningTrigger />
                <ReasoningContent>
                  {displayText}
                </ReasoningContent>
              </Reasoning>
            );
          }

          if (b.type === "toolCall") {
            const toolCallId = typeof b.toolCallId === "string" ? b.toolCallId : "";
            const isActive = toolCallId ? activeToolCalls?.has(toolCallId) : false;
            const toolName = String(b.name ?? "unknown");

            const args =
              b.arguments && typeof b.arguments === "object"
                ? (b.arguments as Record<string, unknown>)
                : typeof b.arguments === "string"
                  ? (() => {
                      try {
                        return JSON.parse(b.arguments as string) as Record<
                          string,
                          unknown
                        >;
                      } catch {
                        return {} as Record<string, unknown>;
                      }
                    })()
                  : ({} as Record<string, unknown>);

            const normalizedToolName = normalizeToolName(toolName);
            const isEdit =
              (normalizedToolName === "edit" || normalizedToolName.endsWith(".edit")) &&
              typeof args.path === "string" &&
              typeof args.oldText === "string" &&
              typeof args.newText === "string";
            const isWrite =
              (normalizedToolName === "write" ||
                normalizedToolName.endsWith(".write") ||
                normalizedToolName === "write_file" ||
                normalizedToolName.endsWith(".write_file")) &&
              typeof args.path === "string" &&
              typeof args.content === "string";

            const state: ToolState = isActive
              ? "input-available"
              : "output-available";

            return (
              <Tool key={i} defaultOpen={false}>
                <ToolHeader type="dynamic-tool" toolName={toolName} state={state} />
                <ToolContent>
                  {isEdit ? (
                    <DiffView
                      path={args.path as string}
                      oldText={args.oldText as string}
                      newText={args.newText as string}
                    />
                  ) : isWrite ? (
                    <WriteFileCard
                      path={args.path as string}
                      content={args.content as string}
                    />
                  ) : (
                    <ToolInput input={args} />
                  )}
                </ToolContent>
              </Tool>
            );
          }

          if (b.type === "image") {
            const source = (b.source && typeof b.source === "object" ? b.source : {}) as Record<string, unknown>;
            const data = typeof b.data === "string" ? b.data : typeof source.data === "string" ? source.data : null;
            const mime = typeof b.mimeType === "string" ? b.mimeType : typeof source.mediaType === "string" ? source.mediaType : "image/png";

            if (data) {
              return (
                <img
                  key={i}
                  src={`data:${mime};base64,${data}`}
                  alt="Message attachment"
                  className="max-h-80 max-w-full rounded border border-border"
                />
              );
            }
          }

          return (
            <pre key={i} className="text-xs bg-muted/60 rounded p-2 overflow-x-auto">
              {JSON.stringify(block, null, 2)}
            </pre>
          );
        })}
      </div>
    );
  }

  if (content === undefined || content === null) {
    return null;
  }

  return (
    <pre className="text-xs bg-muted/60 rounded p-2 overflow-x-auto">
      {JSON.stringify(content, null, 2)}
    </pre>
  );
}
