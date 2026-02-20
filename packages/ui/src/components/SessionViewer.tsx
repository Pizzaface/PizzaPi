import * as React from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { cn } from "@/lib/utils";
import { MessageSquare } from "lucide-react";

export interface RelayMessage {
  key: string;
  role: string;
  timestamp?: number;
  content?: unknown;
  toolName?: string;
  isError?: boolean;
}

export interface SessionViewerProps {
  sessionId: string | null;
  messages: RelayMessage[];
  onSendInput?: (text: string) => boolean | void | Promise<boolean | void>;
}

function toMessageRole(role: string): "user" | "assistant" | "system" | "tool" | "data" {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "system") return "system";
  if (role === "toolResult" || role === "tool") return "tool";
  return "assistant";
}

function renderContent(content: unknown) {
  if (typeof content === "string") {
    return <MessageResponse>{content}</MessageResponse>;
  }

  if (Array.isArray(content)) {
    return (
      <div className="flex flex-col gap-2">
        {content.map((block, i) => {
          if (!block || typeof block !== "object") {
            return (
              <pre key={i} className="text-xs bg-muted/60 rounded p-2 overflow-x-auto">
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
            return (
              <details key={i} className="rounded border border-border/80 bg-muted/30 p-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">Reasoning</summary>
                <pre className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
                  {typeof b.thinking === "string" ? b.thinking : ""}
                </pre>
              </details>
            );
          }

          if (b.type === "toolCall") {
            return (
              <div key={i} className="rounded border border-border/80 bg-muted/30 p-2">
                <p className="text-xs font-semibold">Tool call: {String(b.name ?? "unknown")}</p>
                <pre className="mt-1 text-xs overflow-x-auto">{JSON.stringify(b.arguments ?? {}, null, 2)}</pre>
              </div>
            );
          }

          if (b.type === "image" && typeof b.data === "string") {
            const mime = typeof b.mimeType === "string" ? b.mimeType : "image/png";
            return (
              <img
                key={i}
                src={`data:${mime};base64,${b.data}`}
                alt="Message attachment"
                className="max-h-80 max-w-full rounded border border-border"
              />
            );
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
    return <p className="text-sm italic text-muted-foreground">(no content)</p>;
  }

  return (
    <pre className="text-xs bg-muted/60 rounded p-2 overflow-x-auto">
      {JSON.stringify(content, null, 2)}
    </pre>
  );
}

function roleLabel(role: string) {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "toolResult") return "Tool";
  return role || "Message";
}

export function SessionViewer({ sessionId, messages, onSendInput }: SessionViewerProps) {
  const [input, setInput] = React.useState("");

  React.useEffect(() => {
    if (!sessionId) setInput("");
  }, [sessionId]);

  const handleSubmit = React.useCallback(
    (message: PromptInputMessage) => {
      const text = message.text.trim();
      if (!text || !sessionId || !onSendInput) return;

      Promise.resolve(onSendInput(text)).then((result) => {
        if (result !== false) setInput("");
      });
    },
    [onSendInput, sessionId],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="border-b border-border px-4 py-2 flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Session Viewer</p>
          <p className="text-sm font-medium truncate">
            {sessionId ? `Session ${sessionId}` : "No session selected"}
          </p>
        </div>
      </div>

      <Conversation className="flex-1 min-h-0">
        <ConversationContent className="gap-3 px-4 py-3">
          {!sessionId ? (
            <ConversationEmptyState
              icon={<MessageSquare className="size-8" />}
              title="No session selected"
              description="Pick a session from the sidebar."
            />
          ) : messages.length === 0 ? (
            <ConversationEmptyState
              title="Waiting for session events"
              description="Messages will appear here in real time."
            />
          ) : (
            messages.map((message) => (
              <Message key={message.key} from={toMessageRole(message.role)}>
                <MessageContent
                  className={cn(
                    "max-w-3xl rounded-lg border px-3 py-2",
                    message.role === "user"
                      ? "ml-auto bg-primary text-primary-foreground border-primary/40"
                      : "bg-card text-card-foreground border-border",
                  )}
                >
                  <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide opacity-70">
                    <span>{roleLabel(message.role)}</span>
                    {message.toolName && <span>• {message.toolName}</span>}
                    {message.timestamp && <span>• {new Date(message.timestamp).toLocaleTimeString()}</span>}
                    {message.isError && <span className="text-destructive">• Error</span>}
                  </div>
                  {renderContent(message.content)}
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t border-border px-3 py-2">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              value={input}
              onChange={(event) => setInput(event.currentTarget.value)}
              disabled={!sessionId}
              placeholder={sessionId ? "Send a message to this session…" : "Pick a session to chat"}
              className="min-h-12 max-h-36"
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <span className="px-2 text-xs text-muted-foreground">
                {sessionId ? "Press Enter to send" : "Select a session to send messages"}
              </span>
            </PromptInputTools>
            <PromptInputSubmit status="ready" disabled={!sessionId || !input.trim()} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
