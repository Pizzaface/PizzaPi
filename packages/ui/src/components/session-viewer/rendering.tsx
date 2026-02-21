import * as React from "react";
import type { BundledLanguage } from "shiki";

import { CodeBlock } from "@/components/ai-elements/code-block";
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
  tryParseJsonObject,
} from "@/components/session-viewer/utils";
import { ChevronDownIcon } from "lucide-react";

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
      <CodeBlock code={resolvedCode} language={lang} className="border-0 rounded-none" />
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
      <CodeBlock
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
        <CodeBlock code={text} language="markdown" className="border-border/70" />
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
      return <DiffView path={path} oldText="" newText={newText} />;
    }

    if (text) {
      return (
        <CodeBlock code={text} language="markdown" className="border-border/70" />
      );
    }
  }

  if (text) {
    const trimmed = text.trim();
    const parsed = tryParseJsonObject(trimmed);
    if (parsed) {
      return (
        <CodeBlock
          code={JSON.stringify(parsed, null, 2)}
          language="json"
          className="border-border/70"
        />
      );
    }

    if (trimmed.includes("\n") || trimmed.length > 100) {
      return (
        <CodeBlock code={text} language="markdown" className="border-border/70" />
      );
    }

    return <MessageResponse>{text}</MessageResponse>;
  }

  if (content === undefined || content === null) return null;

  return (
    <CodeBlock
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
      <div className="flex flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-100 text-xs">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <TerminalTitle>{toolName}</TerminalTitle>
          </div>
          <div className="flex items-center gap-2"><StatusBadge status={state} /></div>
        </div>
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
      </div>
    );
  } else if (norm === "read" || norm.endsWith(".read")) {
    if (hasOutput) {
      card = renderReadToolResult(content, isError, toolInput);
    } else {
      const inputArgs =
        toolInput && typeof toolInput === "object"
          ? (toolInput as Record<string, unknown>)
          : {};
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
    const inputArgs =
      toolInput && typeof toolInput === "object"
        ? (toolInput as Record<string, unknown>)
        : {};
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
    const inputArgs =
      toolInput && typeof toolInput === "object"
        ? (toolInput as Record<string, unknown>)
        : {};

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
      card = <DiffView path={writePath} oldText="" newText={newText} />;
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
  } else {
    // Default / Generic
    const commandLine = synthesizeCommandLine(toolName, toolInput);
    const outputText = hasOutput ? extractTextFromToolContent(content) : null;
    card = (
      <Terminal output={outputText ?? ""} isStreaming={isStreaming} className="text-xs">
        <TerminalHeader>
          <TerminalTitle>{toolName}</TerminalTitle>
          <div className="flex items-center gap-2">
            <StatusBadge status={state} />
            <TerminalStatus />
            <TerminalActions>
              {outputText && <TerminalCopyButton />}
            </TerminalActions>
          </div>
        </TerminalHeader>
        <div className="px-4 py-2 font-mono text-xs text-zinc-400 border-b border-zinc-800">
          <span className="text-zinc-600 select-none mr-1">$</span>
          <span className="text-zinc-300">{commandLine}</span>
        </div>
        {hasOutput && <TerminalContent className="text-xs" />}
      </Terminal>
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
  thinkingDuration?: number
) {
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
            return (
              <Reasoning key={i} isStreaming={thinkingIsStreaming} duration={thinkingDuration}>
                <ReasoningTrigger />
                <ReasoningContent>
                  {typeof b.thinking === "string" ? b.thinking : ""}
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
                    <DiffView
                      path={args.path as string}
                      oldText=""
                      newText={args.content as string}
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
