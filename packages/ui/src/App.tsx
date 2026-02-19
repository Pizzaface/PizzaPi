import * as React from "react";
import {
    ApiKeyPromptDialog,
    ChatPanel,
    AppStorage,
    IndexedDBStorageBackend,
    setAppStorage,
    SettingsStore,
    ProviderKeysStore,
    SessionsStore,
    CustomProvidersStore,
    getAppStorage,
} from "@mariozechner/pi-web-ui";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { SessionSidebar } from "@/components/SessionSidebar";
import { AuthPage } from "@/components/AuthPage";
import { ApiKeyManager } from "@/components/ApiKeyManager";
import { authClient, useSession, signOut } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Sun, Moon, LogOut, KeyRound, X } from "lucide-react";

// ── Storage bootstrap (run once outside React) ─────────────────────────────────

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

const backend = new IndexedDBStorageBackend({
    dbName: "pizzapi",
    version: 2,
    stores: [
        settings.getConfig(),
        SessionsStore.getMetadataConfig(),
        providerKeys.getConfig(),
        customProviders.getConfig(),
        sessions.getConfig(),
    ],
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);

// ── Helpers ────────────────────────────────────────────────────────────────────

function createDefaultAgent(): Agent {
    return new Agent({
        initialState: {
            systemPrompt: "You are PizzaPi, a helpful AI assistant.",
            model: getModel("anthropic", "claude-sonnet-4-5-20250929"),
            thinkingLevel: "off",
            messages: [],
            tools: [],
        },
    });
}

// ── App ────────────────────────────────────────────────────────────────────────

export function App() {
    const { data: session, isPending } = useSession();
    const [isDark, setIsDark] = React.useState(() => {
        const saved = localStorage.getItem("theme");
        return saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches);
    });
    const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
    const [showApiKeys, setShowApiKeys] = React.useState(false);
    const chatPanelRef = React.useRef<InstanceType<typeof ChatPanel> | null>(null);
    const chatContainerRef = React.useRef<HTMLDivElement>(null);

    // Apply dark mode class
    React.useEffect(() => {
        document.documentElement.classList.toggle("dark", isDark);
        localStorage.setItem("theme", isDark ? "dark" : "light");
    }, [isDark]);

    // Mount ChatPanel (LitElement) into the container div
    React.useEffect(() => {
        if (!chatContainerRef.current) return;
        const panel = new ChatPanel();
        chatPanelRef.current = panel;
        chatContainerRef.current.appendChild(panel);
        return () => {
            chatContainerRef.current?.removeChild(panel);
            chatPanelRef.current = null;
        };
    }, []);

    async function loadAgent(agent: Agent, sessionId: string | null = null) {
        setActiveSessionId(sessionId);
        await chatPanelRef.current?.setAgent(agent, {
            onApiKeyRequired: async (provider: string) => {
                return await ApiKeyPromptDialog.prompt(provider);
            },
            onBeforeSend: async () => {},
        });
    }

    async function handleLoadSession(sessionId: string) {
        try {
            const store = getAppStorage();
            const data = await store.sessions.loadSession(sessionId);
            if (!data) return;
            const agent = new Agent({
                initialState: {
                    systemPrompt: "You are PizzaPi, a helpful AI assistant.",
                    model: data.model ?? getModel("anthropic", "claude-sonnet-4-5-20250929"),
                    thinkingLevel: data.thinkingLevel ?? "off",
                    messages: data.messages ?? [],
                    tools: [],
                },
            });
            await loadAgent(agent, sessionId);
        } catch (err) {
            console.error("Failed to load session:", err);
        }
    }

    async function handleNewSession() {
        await loadAgent(createDefaultAgent(), null);
    }

    // Load default agent once chat panel is mounted and user is authenticated
    const initializedRef = React.useRef(false);
    React.useEffect(() => {
        if (session && chatPanelRef.current && !initializedRef.current) {
            initializedRef.current = true;
            loadAgent(createDefaultAgent(), null);
        }
    });

    if (isPending) {
        return (
            <div className="flex h-screen w-screen items-center justify-center bg-background">
                <span className="text-muted-foreground text-sm">Loading…</span>
            </div>
        );
    }

    if (!session) {
        return <AuthPage onAuthenticated={() => authClient.getSession()} />;
    }

    return (
        <div className="flex h-screen w-screen overflow-hidden bg-background relative">
            <SessionSidebar
                onLoadSession={handleLoadSession}
                onNewSession={handleNewSession}
                activeSessionId={activeSessionId}
            />

            {/* Main content */}
            <div className="flex flex-col flex-1 min-w-0 h-full relative">
                <div ref={chatContainerRef} className="flex-1 min-h-0 flex flex-col [&>pi-chat-panel]:flex-1 [&>pi-chat-panel]:min-h-0" />
            </div>

            {/* Theme toggle */}
            <Button
                variant="outline"
                size="icon"
                className="fixed bottom-4 right-4 z-50 h-9 w-9 rounded-full shadow-md"
                onClick={() => setIsDark((d) => !d)}
                aria-label="Toggle dark mode"
            >
                {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>

            {/* API keys button */}
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

            {/* Sign out */}
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

            {/* API key manager panel */}
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
