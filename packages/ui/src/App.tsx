import * as React from "react";
import { SessionSidebar, type DotState } from "@/components/SessionSidebar";
import { SessionViewer, type RelayMessage } from "@/components/SessionViewer";
import { AuthPage } from "@/components/AuthPage";
import { ApiKeyManager } from "@/components/ApiKeyManager";
import { authClient, useSession, signOut } from "@/lib/auth-client";
import { getRelayWsBase } from "@/lib/relay";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sun, Moon, LogOut, KeyRound, X, User } from "lucide-react";

function toRelayMessage(raw: unknown, fallbackId: string): RelayMessage | null {
  if (!raw || typeof raw !== "object") return null;

  const msg = raw as Record<string, unknown>;
  const role = typeof msg.role === "string" ? msg.role : "message";
  const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : undefined;
  const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
  const key = `${role}:${timestamp ?? ""}:${toolCallId || fallbackId}`;

  return {
    key,
    role,
    timestamp,
    content: msg.content,
    toolName: typeof msg.toolName === "string" ? msg.toolName : undefined,
    isError: msg.isError === true,
  };
}

function normalizeMessages(rawMessages: unknown[]): RelayMessage[] {
  return rawMessages
    .map((m, i) => toRelayMessage(m, `snapshot-${i}`))
    .filter((m): m is RelayMessage => m !== null);
}

export function App() {
  const { data: session, isPending } = useSession();
  const [isDark, setIsDark] = React.useState(() => {
    const saved = localStorage.getItem("theme");
    return saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches);
  });
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<RelayMessage[]>([]);
  const [viewerStatus, setViewerStatus] = React.useState("Idle");
  const [relayStatus, setRelayStatus] = React.useState<DotState>("connecting");
  const [showApiKeys, setShowApiKeys] = React.useState(false);

  const viewerWsRef = React.useRef<WebSocket | null>(null);
  const activeSessionRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    localStorage.setItem("theme", isDark ? "dark" : "light");
  }, [isDark]);

  React.useEffect(() => {
    return () => {
      viewerWsRef.current?.close();
      viewerWsRef.current = null;
    };
  }, []);

  const clearSelection = React.useCallback(() => {
    viewerWsRef.current?.close();
    viewerWsRef.current = null;
    activeSessionRef.current = null;
    setActiveSessionId(null);
    setMessages([]);
    setViewerStatus("Idle");
  }, []);

  const upsertMessage = React.useCallback((raw: unknown, fallback: string) => {
    const next = toRelayMessage(raw, fallback);
    if (!next) return;

    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.key === next.key);
      if (idx >= 0) {
        const updated = prev.slice();
        updated[idx] = next;
        return updated;
      }
      return [...prev, next];
    });
  }, []);

  const handleRelayEvent = React.useCallback((event: unknown) => {
    if (!event || typeof event !== "object") return;

    const evt = event as Record<string, unknown>;
    const type = typeof evt.type === "string" ? evt.type : "";

    if (type === "session_active") {
      const state = evt.state as Record<string, unknown> | undefined;
      const rawMessages = Array.isArray(state?.messages) ? (state?.messages as unknown[]) : [];
      setMessages(normalizeMessages(rawMessages));
      setViewerStatus("Connected");
      return;
    }

    if (type === "agent_end" && Array.isArray(evt.messages)) {
      setMessages(normalizeMessages(evt.messages as unknown[]));
      return;
    }

    if (type === "message_update") {
      const assistantEvent = evt.assistantMessageEvent as Record<string, unknown> | undefined;
      if (assistantEvent && assistantEvent.partial) {
        upsertMessage(assistantEvent.partial, "message-update-partial");
        return;
      }
      upsertMessage(evt.message, "message-update");
      return;
    }

    if (type === "message_start" || type === "message_end" || type === "turn_end") {
      upsertMessage(evt.message, type);
    }
  }, [upsertMessage]);

  const openSession = React.useCallback((relaySessionId: string) => {
    viewerWsRef.current?.close();
    viewerWsRef.current = null;

    activeSessionRef.current = relaySessionId;
    setActiveSessionId(relaySessionId);
    setMessages([]);
    setViewerStatus("Connecting…");

    const ws = new WebSocket(`${getRelayWsBase()}/ws/sessions/${relaySessionId}`);
    viewerWsRef.current = ws;

    ws.onmessage = (evt) => {
      if (activeSessionRef.current !== relaySessionId) return;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(evt.data as string);
      } catch {
        return;
      }

      if (msg.type === "connected") {
        const replayOnly = msg.replayOnly === true;
        setViewerStatus(replayOnly ? "Snapshot replay" : "Connected");
        return;
      }

      if (msg.type === "event") {
        handleRelayEvent(msg.event);
        return;
      }

      if (msg.type === "disconnected") {
        const reason = typeof msg.reason === "string" ? msg.reason : "Disconnected";
        setViewerStatus(reason);
        return;
      }

      if (msg.type === "error") {
        setViewerStatus(typeof msg.message === "string" ? msg.message : "Failed to load session");
      }
    };

    ws.onerror = () => {
      if (activeSessionRef.current === relaySessionId) {
        setViewerStatus("Connection error");
      }
    };

    ws.onclose = () => {
      if (activeSessionRef.current === relaySessionId) {
        setViewerStatus((prev) => (prev === "Connected" || prev === "Connecting…" ? "Disconnected" : prev));
      }
    };
  }, [handleRelayEvent]);

  const sendSessionInput = React.useCallback((text: string) => {
    const ws = viewerWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeSessionRef.current) {
      setViewerStatus("Not connected to a live session");
      return false;
    }

    try {
      ws.send(JSON.stringify({ type: "input", text }));
      upsertMessage(
        {
          role: "user",
          timestamp: Date.now(),
          toolCallId: `viewer-input-${Math.random().toString(36).slice(2, 8)}`,
          content: text,
        },
        "viewer-input",
      );
      return true;
    } catch {
      setViewerStatus("Failed to send message");
      return false;
    }
  }, [upsertMessage]);

  if (isPending) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <span className="text-muted-foreground text-sm">Loading…</span>
      </div>
    );
  }

  if (!session) {
    return <AuthPage onAuthenticated={() => authClient.$store.notify("$sessionSignal")} />;
  }

  const rawUser = session && typeof session === "object" ? (session as any).user : undefined;
  const userName = rawUser && typeof rawUser.name === "string" ? (rawUser.name as string) : "";
  const userEmail = rawUser && typeof rawUser.email === "string" ? (rawUser.email as string) : "";
  const userLabel = userName || userEmail || "Account";

  function relayStatusLabel(status: DotState) {
    if (status === "connected") return "Relay connected";
    if (status === "connecting") return "Connecting…";
    return "Relay disconnected";
  }

  function relayStatusDot(status: DotState) {
    return `inline-block h-2 w-2 rounded-full ${status === "connected" ? "bg-green-500 shadow-[0_0_4px_#22c55e80]" : status === "connecting" ? "bg-slate-400" : "bg-red-500"}`;
  }

  function initials(value: string) {
    const parts = value
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    return parts.map((p) => p[0]?.toUpperCase()).join("") || "U";
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      <header className="flex items-center justify-between gap-3 border-b bg-background px-4 py-2 flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-semibold">PizzaPi</span>
          <Separator orientation="vertical" className="h-5" />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={relayStatusDot(relayStatus)} />
            <span>{relayStatusLabel(relayStatus)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={() => setIsDark((d) => !d)}
            aria-label="Toggle dark mode"
            title="Toggle dark mode"
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={() => setShowApiKeys(true)}
            aria-label="Manage API keys"
            title="Manage API keys"
          >
            <KeyRound className="h-4 w-4" />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2 max-w-56">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">
                  {initials(userLabel)}
                </span>
                <span className="truncate text-left">{userLabel}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{userName || "Signed in"}</span>
              </DropdownMenuLabel>
              {userEmail && (
                <div className="px-2 pb-1 text-xs text-muted-foreground truncate">{userEmail}</div>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setShowApiKeys(true)}>
                <KeyRound className="h-4 w-4" />
                API keys
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => signOut()}>
                <LogOut className="h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="flex flex-1 min-h-0 overflow-hidden relative">
        <SessionSidebar
          onOpenSession={openSession}
          onClearSelection={clearSelection}
          activeSessionId={activeSessionId}
          onRelayStatusChange={setRelayStatus}
        />

        <div className="flex flex-col flex-1 min-w-0 h-full relative">
          <SessionViewer sessionId={activeSessionId} messages={messages} onSendInput={sendSessionInput} />
        </div>

        {showApiKeys && (
          <div className="absolute inset-y-0 right-0 z-40 flex w-full max-w-md flex-col shadow-xl border-l bg-background">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm">API Keys</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setShowApiKeys(false)}
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <ApiKeyManager />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
