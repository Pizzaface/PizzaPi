import * as React from "react";
import type { BundledLanguage } from "shiki";

import { DiffView } from "@/components/ai-elements/diff-view";
import {
  StatusBadge,
  type ToolPart,
} from "@/components/ai-elements/tool";

type ToolState = ToolPart["state"];
import {
  Terminal,
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
import { ChevronDownIcon, WrenchIcon, Loader2Icon, XCircleIcon as XCircleIcon2 } from "lucide-react";
import {
  ToolCardShell,
  ToolCardHeader,
  ToolCardTitle,
  ToolCardActions,
  StatusPill,
} from "@/components/ui/tool-card";

import { CopyableCodeBlock } from "@/components/session-viewer/cards/InterAgentCards";
import { WriteFileCard } from "@/components/session-viewer/cards/WriteFileCard";
import { TodoCard, type TodoItem } from "@/components/session-viewer/cards/TodoCard";
import { SessionNameCard } from "@/components/session-viewer/cards/SessionNameCard";
import {
  truncateSessionId,
  SpawnSessionCard,
  SendMessageCard,
  WaitForMessageCard,
  CheckMessagesCard,
  GetSessionIdCard,
} from "@/components/session-viewer/cards/InterAgentCards";

export function extToLang(path: string): BundledLanguage {
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

export function metadataBadge(label: string, value: string) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border/70 bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
      <span className="opacity-70">{label}:</span>
      <span className="font-mono text-foreground/90">{value}</span>
    </span>
  );
}

export function renderReadToolResult(
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

export function renderToolResult(content: unknown, toolName?: string, isError?: boolean) {
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

export function synthesizeCommandLine(toolName: string, toolInput: unknown): string {
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

export function renderGroupedToolExecution(
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
