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
import { RocketIcon, SendIcon, InboxIcon, ClockIcon, HashIcon, ExternalLinkIcon, MessageSquareIcon, Loader2Icon, XCircleIcon as XCircleIcon2, CheckCircle2Icon } from "lucide-react";
import {
  ToolCardShell,
  ToolCardHeader,
  ToolCardTitle,
  ToolCardActions,
  ToolCardSection,
  StatusPill,
} from "@/components/ui/tool-card";

export function truncateSessionId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Parse the text result of spawn_session to extract structured details.
 */
export function parseSpawnResult(text: string | null): {
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

export function SpawnSessionCard({
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

export function SendMessageCard({
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

export function WaitForMessageCard({
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

export function CheckMessagesCard({
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

export function GetSessionIdCard({ sessionId }: { sessionId: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-xs text-zinc-400">
      <HashIcon className="size-3.5 shrink-0 text-zinc-500" />
      <span>
        Session ID: <span className="font-mono font-medium text-zinc-200">{sessionId}</span>
      </span>
    </div>
  );
}

export function CopyableCodeBlock({
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
