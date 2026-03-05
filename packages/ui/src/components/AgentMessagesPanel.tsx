import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, ArrowUp, ArrowDown, Bot, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

// ── Types ────────────────────────────────────────────────────────────────────

/** Direction of the inter-agent message */
export type AgentMessageDirection = "sent" | "received";

/** An inter-agent message to render in the panel */
export interface AgentMessage {
  /** Unique ID for this message */
  id: string;
  /** Which session sent this message */
  fromSessionId: string;
  /** Display name of the sending session (falls back to truncated ID) */
  fromSessionName?: string | null;
  /** Which session received this message */
  toSessionId: string;
  /** Display name of the receiving session (falls back to truncated ID) */
  toSessionName?: string | null;
  /** The message text */
  message: string;
  /** When the message was sent/received (unix ms) */
  timestamp: number;
  /** Whether this is a sent or received message relative to the current session */
  direction: AgentMessageDirection;
  /** Whether this is a completion/result message */
  isCompletion?: boolean;
}

export interface AgentMessagesPanelProps {
  /** Current session ID */
  sessionId: string;
  /** Chronological list of inter-agent messages for this session */
  messages: AgentMessage[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncateSessionId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function sessionLabel(name: string | null | undefined, id: string): string {
  return name?.trim() || truncateSessionId(id);
}

// ── Components ───────────────────────────────────────────────────────────────

function AgentMessageItem({ msg }: { msg: AgentMessage }) {
  const isSent = msg.direction === "sent";
  const counterpartId = isSent ? msg.toSessionId : msg.fromSessionId;
  const counterpartName = isSent ? msg.toSessionName : msg.fromSessionName;
  const label = sessionLabel(counterpartName, counterpartId);

  return (
    <div
      className={cn(
        "flex flex-col gap-1 px-3 py-2",
        isSent ? "items-end" : "items-start",
      )}
    >
      {/* Header: direction arrow + session label + timestamp */}
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        {isSent ? (
          <>
            <ArrowUp className="size-3 text-blue-400" />
            <span>→ {label}</span>
          </>
        ) : (
          <>
            <ArrowDown className="size-3 text-emerald-400" />
            <span>← {label}</span>
          </>
        )}
        <span className="opacity-60">·</span>
        <span className="opacity-60">{formatTime(msg.timestamp)}</span>
      </div>

      {/* Message bubble */}
      <div
        className={cn(
          "max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words",
          isSent
            ? "rounded-br-sm bg-blue-600/15 border border-blue-500/20 text-foreground"
            : "rounded-bl-sm bg-emerald-600/10 border border-emerald-500/20 text-foreground",
        )}
      >
        {msg.message}
      </div>

      {/* Completion badge */}
      {msg.isCompletion && (
        <Badge
          variant="outline"
          className="text-[10px] px-1.5 py-0 border-violet-500/40 text-violet-400"
        >
          Completion
        </Badge>
      )}
    </div>
  );
}

/**
 * Collapsible panel showing chronological inter-agent message flow.
 *
 * - Direction arrows: ↑ sent, ↓ received
 * - Completion messages styled with a distinct badge
 * - Auto-scrolls to newest messages
 * - Collapse state persisted in local state
 *
 * Renders nothing when there are no messages to show.
 */
export const AgentMessagesPanel = React.memo(function AgentMessagesPanel({
  sessionId,
  messages,
}: AgentMessagesPanelProps) {
  const [isOpen, setIsOpen] = React.useState(() => {
    try {
      return localStorage.getItem("pp-agent-messages-open") !== "false";
    } catch {
      return true;
    }
  });

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const prevMessageCountRef = React.useRef(0);

  // Persist collapse state
  const handleOpenChange = React.useCallback((open: boolean) => {
    setIsOpen(open);
    try {
      localStorage.setItem("pp-agent-messages-open", String(open));
    } catch {
      // best-effort
    }
  }, []);

  // Auto-scroll to bottom when new messages arrive
  React.useEffect(() => {
    if (messages.length > prevMessageCountRef.current && scrollRef.current && isOpen) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length, isOpen]);

  if (messages.length === 0) return null;

  return (
    <Collapsible open={isOpen} onOpenChange={handleOpenChange}>
      <div className="border-t border-border">
        {/* Sticky header */}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 w-full px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <MessageSquare className="size-3.5" />
            <span className="uppercase tracking-wider flex-1 text-left">
              Agent Messages
            </span>
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
              {messages.length}
            </Badge>
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform duration-200",
                isOpen && "rotate-180",
              )}
            />
          </button>
        </CollapsibleTrigger>

        {/* Message list */}
        <CollapsibleContent>
          <div
            ref={scrollRef}
            className="max-h-64 overflow-y-auto divide-y divide-border/50"
          >
            {messages.map((msg) => (
              <AgentMessageItem key={msg.id} msg={msg} />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
});
