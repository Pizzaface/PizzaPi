import * as React from "react";
import { SessionSidebar } from "@/components/SessionSidebar";
import { SessionViewer, type RelayMessage } from "@/components/SessionViewer";
import { AuthPage } from "@/components/AuthPage";
import { ApiKeyManager } from "@/components/ApiKeyManager";
import { authClient, useSession, signOut } from "@/lib/auth-client";
import { getRelayWsBase } from "@/lib/relay";
import { Button } from "@/components/ui/button";
import { Sun, Moon, LogOut, KeyRound, X } from "lucide-react";

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

    return (
        <div className="flex h-screen w-screen overflow-hidden bg-background relative">
            <SessionSidebar
                onOpenSession={openSession}
                onClearSelection={clearSelection}
                activeSessionId={activeSessionId}
            />

            <div className="flex flex-col flex-1 min-w-0 h-full relative">
                <SessionViewer
                    sessionId={activeSessionId}
                    messages={messages}
                    status={viewerStatus}
                    onSendInput={sendSessionInput}
                />
            </div>

            <Button
                variant="outline"
                size="icon"
                className="fixed bottom-4 right-4 z-50 h-9 w-9 rounded-full shadow-md"
                onClick={() => setIsDark((d) => !d)}
                aria-label="Toggle dark mode"
            >
                {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>

            <Button
                variant="ghost"
                size="icon"
                className="fixed bottom-4 right-28 z-50 h-9 w-9 rounded-full"
                onClick={() => setShowApiKeys((v) => !v)}
                aria-label="Manage API keys"
                title="Manage API keys"
            >
                <KeyRound className="h-4 w-4" />
            </Button>

            <Button
                variant="ghost"
                size="icon"
                className="fixed bottom-4 right-16 z-50 h-9 w-9 rounded-full"
                onClick={() => signOut()}
                aria-label="Sign out"
                title="Sign out"
            >
                <LogOut className="h-4 w-4" />
            </Button>

            {showApiKeys && (
                <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col shadow-xl border-l bg-background">
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
    );
}
