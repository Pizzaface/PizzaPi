import type { SessionMetadata } from "@mariozechner/pi-web-ui";
import { getAppStorage } from "@mariozechner/pi-web-ui";

// ── Types ─────────────────────────────────────────────────────────────────────

interface HubSession {
    sessionId: string;
    shareUrl: string;
    cwd: string;
    startedAt: string;
    viewerCount?: number;
}

export interface SidebarCallbacks {
    onLoadSession: (sessionId: string) => Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRelativeDate(isoString: string): string {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days} days ago`;
    return date.toLocaleDateString();
}

function cwdLabel(cwd: string): string {
    if (!cwd) return "Unknown node";
    const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || cwd;
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, string> = {},
    ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") e.className = v;
        else e.setAttribute(k, v);
    }
    for (const c of children) {
        e.append(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
}

// ── Sidebar class ─────────────────────────────────────────────────────────────

export class SessionSidebar {
    readonly element: HTMLElement;

    private _callbacks: SidebarCallbacks;
    private _liveSessions: HubSession[] = [];
    private _storedSessions: SessionMetadata[] = [];
    private _activeSessionId: string | null = null;
    private _ws: WebSocket | null = null;
    private _wsRetryDelay = 1000;
    private _destroyed = false;

    private _liveListEl: HTMLElement;
    private _storedListEl: HTMLElement;
    private _liveSectionEl: HTMLElement;

    constructor(callbacks: SidebarCallbacks) {
        this._callbacks = callbacks;

        // Build skeleton
        this._liveListEl = el("div", { class: "sidebar-group-items" });
        this._storedListEl = el("div", { class: "sidebar-group-items" });

        const liveHeader = el("div", { class: "sidebar-group-header" },
            el("span", { class: "sidebar-group-label" }, "Live Sessions"),
            el("span", { class: "sidebar-live-dot", title: "Connecting…" }),
        );

        this._liveSectionEl = el("div", { class: "sidebar-group" }, liveHeader, this._liveListEl);

        const storedHeader = el("div", { class: "sidebar-group-header" },
            el("span", { class: "sidebar-group-label" }, "History"),
        );

        const newBtn = el("button", { class: "sidebar-new-btn", title: "New session" }, "+ New");
        newBtn.addEventListener("click", () => this._handleNewSession());

        const collapseBtn = el("button", { class: "sidebar-collapse-btn", title: "Collapse sidebar", "aria-label": "Collapse sidebar" }, "☰");
        collapseBtn.addEventListener("click", () => {
            this.element.dispatchEvent(new CustomEvent("sidebar:toggle", { bubbles: true }));
        });

        const topBar = el("div", { class: "sidebar-topbar" },
            collapseBtn,
            el("span", { class: "sidebar-title" }, "Sessions"),
            newBtn,
        );

        this.element = el("aside", { id: "session-sidebar" },
            topBar,
            this._liveSectionEl,
            el("div", { class: "sidebar-group" }, storedHeader, this._storedListEl),
        );

        this._loadStoredSessions();
        this._connectHub();
    }

    setActiveSession(id: string | null) {
        this._activeSessionId = id;
        this._renderStored();
    }

    destroy() {
        this._destroyed = true;
        this._ws?.close();
    }

    // ── Hub WebSocket ─────────────────────────────────────────────────────────

    private _connectHub() {
        if (this._destroyed) return;

        const relayBase = ((import.meta as any).env?.VITE_RELAY_URL ?? "ws://localhost:3000").replace(/\/$/, "");
        const wsUrl = `${relayBase}/ws/hub`;

        try {
            const ws = new WebSocket(wsUrl);
            this._ws = ws;

            ws.onopen = () => {
                this._wsRetryDelay = 1000;
                this._setLiveDot("connected");
            };

            ws.onmessage = (evt) => {
                let msg: Record<string, unknown>;
                try { msg = JSON.parse(evt.data as string); } catch { return; }
                this._handleHubMessage(msg);
            };

            ws.onerror = () => { /* close will fire */ };

            ws.onclose = () => {
                this._setLiveDot("disconnected");
                if (!this._destroyed) {
                    setTimeout(() => {
                        this._wsRetryDelay = Math.min(this._wsRetryDelay * 2, 30_000);
                        this._connectHub();
                    }, this._wsRetryDelay);
                }
            };
        } catch {
            this._setLiveDot("disconnected");
        }
    }

    private _handleHubMessage(msg: Record<string, unknown>) {
        switch (msg.type) {
            case "sessions": {
                this._liveSessions = (msg.sessions as HubSession[]) ?? [];
                this._renderLive();
                break;
            }
            case "session_added": {
                const s = msg as unknown as HubSession & { type: string };
                this._liveSessions.push({ sessionId: s.sessionId, shareUrl: s.shareUrl, cwd: s.cwd, startedAt: s.startedAt });
                this._renderLive();
                break;
            }
            case "session_removed": {
                this._liveSessions = this._liveSessions.filter((s) => s.sessionId !== msg.sessionId);
                this._renderLive();
                break;
            }
        }
    }

    private _setLiveDot(state: "connecting" | "connected" | "disconnected") {
        const dot = this._liveSectionEl.querySelector(".sidebar-live-dot") as HTMLElement | null;
        if (!dot) return;
        dot.className = `sidebar-live-dot sidebar-live-dot--${state}`;
        dot.title = state === "connected" ? "Connected" : state === "disconnected" ? "Disconnected" : "Connecting…";
    }

    // ── Stored sessions ───────────────────────────────────────────────────────

    private async _loadStoredSessions() {
        try {
            const storage = getAppStorage();
            this._storedSessions = await storage.sessions.getAllMetadata();
        } catch {
            this._storedSessions = [];
        }
        this._renderStored();
    }

    async refresh() {
        await this._loadStoredSessions();
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    private _renderLive() {
        this._liveListEl.innerHTML = "";

        if (this._liveSessions.length === 0) {
            this._liveListEl.append(el("div", { class: "sidebar-empty" }, "No live sessions"));
            return;
        }

        // Group by cwd
        const groups = new Map<string, HubSession[]>();
        for (const s of this._liveSessions) {
            const key = s.cwd || "";
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(s);
        }

        for (const [cwd, sessions] of groups) {
            const nodeLabel = cwdLabel(cwd);
            const nodeHeader = el("div", { class: "sidebar-node-header" },
                el("span", { class: "sidebar-node-icon" }, "⬡"),
                el("span", { class: "sidebar-node-label", title: cwd }, nodeLabel),
            );
            this._liveListEl.append(nodeHeader);

            for (const s of sessions) {
                const item = el("a", {
                    class: "sidebar-item sidebar-item--live",
                    href: s.shareUrl,
                    target: "_blank",
                    rel: "noopener",
                    title: s.shareUrl,
                },
                    el("span", { class: "sidebar-item-title" }, `Session ${s.sessionId.slice(0, 8)}…`),
                    el("span", { class: "sidebar-item-meta" }, formatRelativeDate(s.startedAt)),
                );
                this._liveListEl.append(item);
            }
        }
    }

    private _renderStored() {
        this._storedListEl.innerHTML = "";

        if (this._storedSessions.length === 0) {
            this._storedListEl.append(el("div", { class: "sidebar-empty" }, "No saved sessions"));
            return;
        }

        // Group by relative date label
        const groups = new Map<string, SessionMetadata[]>();
        for (const s of this._storedSessions) {
            const label = formatRelativeDate(s.lastModified);
            if (!groups.has(label)) groups.set(label, []);
            groups.get(label)!.push(s);
        }

        for (const [label, sessions] of groups) {
            const groupHeader = el("div", { class: "sidebar-node-header" },
                el("span", { class: "sidebar-node-label" }, label),
            );
            this._storedListEl.append(groupHeader);

            for (const s of sessions) {
                const isActive = s.id === this._activeSessionId;
                const item = el("button", {
                    class: `sidebar-item${isActive ? " sidebar-item--active" : ""}`,
                    title: s.title || s.id,
                },
                    el("span", { class: "sidebar-item-title" }, s.title || "Untitled"),
                    el("span", { class: "sidebar-item-meta" }, `${s.messageCount} msgs`),
                );
                item.addEventListener("click", () => this._callbacks.onLoadSession(s.id));
                this._storedListEl.append(item);
            }
        }
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    private _handleNewSession() {
        // Dispatch a custom event that main.ts can listen to
        this.element.dispatchEvent(new CustomEvent("sidebar:new-session", { bubbles: true }));
    }
}
