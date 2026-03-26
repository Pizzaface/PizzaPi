/**
 * Mock runner client for integration tests.
 *
 * Connects to a test server's /runner Socket.IO namespace and mimics the
 * behaviour of a real PizzaPi runner daemon with full event parity.
 *
 * Handles all 35+ events the real daemon handles, using in-memory state
 * instead of real filesystem, git, PTY, or process spawning.
 */

import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { randomUUID } from "crypto";

import type {
    RunnerSkill,
    RunnerAgent,
    RunnerPlugin,
    RunnerHook,
    ServicePanelInfo,
} from "@pizzapi/protocol";

import type { TestServer } from "./types.js";

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface MockRunnerSession {
    sessionId: string;
    cwd: string;
    model?: unknown;
    agent?: unknown;
    prompt?: string;
    startedAt: number;
}

export interface MockTerminal {
    terminalId: string;
    cwd: string;
    cols: number;
    rows: number;
    inputBuffer: string[];
}

export interface MockFileEntry {
    name: string;
    path: string;
    isDirectory: boolean;
    isSymlink: boolean;
    size?: number;
    content?: string;
}

export interface MockGitStatus {
    branch: string;
    changes: Array<{ status: string; path: string; originalPath?: string }>;
    ahead: number;
    behind: number;
    diffStaged: string;
}

export interface MockSandboxConfig {
    mode: string;
    active: boolean;
    configured: boolean;
    platform: string;
    violations: number;
    recentViolations: unknown[];
    config: Record<string, unknown>;
    rawConfig: Record<string, unknown>;
}

export interface MockUsageData {
    sessions: number;
    models: Record<string, { inputTokens: number; outputTokens: number; cost: number }>;
    totalCost: number;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MockRunnerOptions {
    /** Override the API key used for auth (default: server.apiKey). Pass a bad key to test auth failures. */
    apiKey?: string;
    runnerId?: string;
    name?: string;
    roots?: string[];
    skills?: RunnerSkill[];
    agents?: RunnerAgent[];
    plugins?: RunnerPlugin[];
    hooks?: RunnerHook[];
    version?: string;
    platform?: string;
    /** Initial mock sessions (simulates already-running sessions) */
    initialSessions?: Array<{ sessionId: string; cwd: string }>;
    /** Initial mock filesystem entries for file explorer (keyed by directory path) */
    mockFiles?: Map<string, MockFileEntry[]>;
    /** Initial mock git status */
    mockGitStatus?: MockGitStatus;
    /** Service IDs this runner announces (e.g. ["terminal", "system-monitor"]) */
    serviceIds?: string[];
    /** Service panels to announce (dynamic iframe panels). */
    panels?: ServicePanelInfo[];
}

export interface MockRunner {
    runnerId: string;
    socket: ClientSocket;

    // State accessors
    readonly sessions: ReadonlyMap<string, MockRunnerSession>;
    readonly terminals: ReadonlyMap<string, MockTerminal>;
    readonly skills: RunnerSkill[];
    readonly agents: RunnerAgent[];

    // Session lifecycle helpers
    emitSessionReady(sessionId: string): void;
    emitSessionError(sessionId: string, error: string): void;
    emitSessionEvent(sessionId: string, event: unknown): void;
    emitSessionEnded(sessionId: string): void;

    // New test assertion helpers
    getSession(sessionId: string): MockRunnerSession | undefined;
    getTerminal(terminalId: string): MockTerminal | undefined;
    wasRestartRequested(): boolean;
    wasShutdownRequested(): boolean;

    // Request handler registration (backward compat)
    onSkillRequest(handler: (data: unknown) => unknown): void;
    onFileRequest(handler: (data: unknown) => unknown): void;

    // Services
    announceServices(serviceIds: string[], panels?: ServicePanelInfo[]): void;

    // Utilities
    waitForEvent(eventName: string, timeout?: number): Promise<unknown>;
    disconnect(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default mock data
// ---------------------------------------------------------------------------

function defaultSkills(): RunnerSkill[] {
    return [
        { name: "code-review", description: "Review code for quality, bugs, and style", filePath: "~/.pizzapi/skills/code-review.md" },
        { name: "test-driven-development", description: "Write tests before implementation", filePath: "~/.pizzapi/skills/test-driven-development.md" },
        { name: "brainstorming", description: "Generate ideas and explore approaches", filePath: "~/.pizzapi/skills/brainstorming.md" },
    ];
}

function defaultAgents(): RunnerAgent[] {
    return [
        { name: "task", description: "General-purpose task agent", filePath: "~/.pizzapi/agents/task.md" },
        { name: "reviewer", description: "Code review specialist", filePath: "~/.pizzapi/agents/reviewer.md" },
    ];
}

function defaultPlugins(): RunnerPlugin[] {
    return [
        {
            name: "nightshift",
            description: "Automated overnight task scheduling",
            rootPath: "~/.pizzapi/plugins/nightshift",
            commands: [{ name: "schedule", description: "Schedule a task for overnight execution" }],
            hookEvents: [],
            skills: [],
            hasMcp: false,
            hasAgents: false,
            hasLsp: false,
        },
    ];
}

function defaultMockFiles(): Map<string, MockFileEntry[]> {
    const root = "/tmp/test";
    const files = new Map<string, MockFileEntry[]>();
    files.set(root, [
        { name: "package.json", path: `${root}/package.json`, isDirectory: false, isSymlink: false, size: 512, content: '{"name":"mock-project","version":"1.0.0"}' },
        { name: "README.md", path: `${root}/README.md`, isDirectory: false, isSymlink: false, size: 128, content: "# Mock Project\n\nA test project for mock runner." },
        { name: "tsconfig.json", path: `${root}/tsconfig.json`, isDirectory: false, isSymlink: false, size: 256, content: '{"compilerOptions":{"strict":true}}' },
        { name: "src", path: `${root}/src`, isDirectory: true, isSymlink: false },
        { name: "node_modules", path: `${root}/node_modules`, isDirectory: true, isSymlink: false },
    ]);
    files.set(`${root}/src`, [
        { name: "index.ts", path: `${root}/src/index.ts`, isDirectory: false, isSymlink: false, size: 64, content: 'console.log("hello world");' },
        { name: "utils.ts", path: `${root}/src/utils.ts`, isDirectory: false, isSymlink: false, size: 128, content: "export function add(a: number, b: number) { return a + b; }" },
    ]);
    return files;
}

function defaultGitStatus(): MockGitStatus {
    return {
        branch: "feat/test-harness",
        changes: [
            { status: "M", path: "src/index.ts" },
            { status: "M", path: "package.json" },
        ],
        ahead: 1,
        behind: 0,
        diffStaged: " src/index.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
    };
}

function defaultSandboxConfig(): MockSandboxConfig {
    return {
        mode: "none",
        active: false,
        configured: false,
        platform: "linux",
        violations: 0,
        recentViolations: [],
        config: {},
        rawConfig: {},
    };
}

function defaultUsageData(): MockUsageData {
    return {
        sessions: 5,
        models: {
            "claude-sonnet-4-20250514": { inputTokens: 50000, outputTokens: 12000, cost: 0.42 },
            "claude-haiku-3": { inputTokens: 10000, outputTokens: 3000, cost: 0.02 },
        },
        totalCost: 0.44,
    };
}

// ---------------------------------------------------------------------------
// Skill / Agent name validation (matches real daemon)
// ---------------------------------------------------------------------------

/** Strict validation for create: lowercase, digits, hyphens */
function isValidSkillOrAgentName(name: string): boolean {
    return /^[a-z0-9]$/.test(name) || /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name);
}

/** Relaxed validation for agent updates: allows dots, underscores, uppercase */
function isValidAgentUpdateName(name: string): boolean {
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a mock runner that connects to the given test server's /runner
 * namespace, registers itself, and returns a helper object for emitting
 * events in tests.
 *
 * The mock handles all 35+ events the real daemon handles, using in-memory
 * state instead of real filesystem, git, PTY, or process spawning.
 */
export async function createMockRunner(
    server: TestServer,
    opts?: MockRunnerOptions,
): Promise<MockRunner> {
    const runnerId = opts?.runnerId ?? randomUUID();

    // ── In-memory state ───────────────────────────────────────────────
    const sessionsMap = new Map<string, MockRunnerSession>();
    const terminalsMap = new Map<string, MockTerminal>();
    const skillsMap = new Map<string, RunnerSkill & { content?: string }>();
    const agentsMap = new Map<string, RunnerAgent & { content?: string }>();
    let pluginsList: RunnerPlugin[] = opts?.plugins ?? defaultPlugins();
    const mockFiles: Map<string, MockFileEntry[]> = opts?.mockFiles ?? defaultMockFiles();
    let gitStatus: MockGitStatus = opts?.mockGitStatus ?? defaultGitStatus();
    let sandboxConfig: MockSandboxConfig = defaultSandboxConfig();
    sandboxConfig.platform = opts?.platform ?? "linux";
    let usageData: MockUsageData = defaultUsageData();
    let restartRequested = false;
    let shutdownRequested = false;
    let isShuttingDown = false;

    // Populate initial skills
    const initialSkills = opts?.skills ?? defaultSkills();
    for (const s of initialSkills) {
        skillsMap.set(s.name, { ...s });
    }

    // Populate initial agents
    const initialAgents = opts?.agents ?? defaultAgents();
    for (const a of initialAgents) {
        agentsMap.set(a.name, { ...a });
    }

    // Populate initial sessions
    if (opts?.initialSessions) {
        for (const s of opts.initialSessions) {
            sessionsMap.set(s.sessionId, {
                sessionId: s.sessionId,
                cwd: s.cwd,
                startedAt: Date.now(),
            });
        }
    }

    // ── Helper to get all mock file entries (flattened) ────────────────
    function getAllMockFiles(): MockFileEntry[] {
        const all: MockFileEntry[] = [];
        for (const entries of mockFiles.values()) {
            for (const e of entries) {
                all.push(e);
            }
        }
        return all;
    }

    // ── Socket.IO connection ──────────────────────────────────────────
    const socket: ClientSocket = ioClient(`${server.baseUrl}/runner`, {
        auth: { apiKey: opts?.apiKey ?? server.apiKey },
        transports: ["websocket"],
        reconnection: false,
        forceNew: true,
    });

    let assignedRunnerId = runnerId;
    await new Promise<void>((resolve, reject) => {
        let settled = false;

        const settle = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(registrationTimer);
            fn();
        };

        const registrationTimer = setTimeout(() => {
            if (!settled) {
                settled = true;
                socket.disconnect();
                reject(new Error("Mock runner registration timed out after 5000ms"));
            }
        }, 5_000);

        const connectErrorHandler = (err: Error) => {
            settle(() => reject(new Error(`Mock runner connect_error: ${err.message}`)));
        };

        socket.on("connect_error", connectErrorHandler);

        socket.on("connect", () => {
            if (isShuttingDown) {
                socket.disconnect();
                return;
            }
            socket.emit("register_runner", {
                runnerId,
                name: opts?.name ?? "test-runner",
                roots: opts?.roots ?? ["/tmp/test"],
                skills: Array.from(skillsMap.values()).map(({ content: _, ...s }) => s),
                agents: Array.from(agentsMap.values()).map(({ content: _, ...a }) => a),
                plugins: pluginsList,
                hooks: opts?.hooks ?? [],
                version: opts?.version ?? "1.0.0-test",
                platform: opts?.platform ?? "linux",
            });
        });

        socket.once("runner_registered", (data: { runnerId: string; existingSessions?: Array<{ sessionId: string; cwd?: string }> }) => {
            settle(() => {
                assignedRunnerId = data.runnerId;
                // Re-adopt existing sessions (like real daemon)
                if (data.existingSessions) {
                    for (const s of data.existingSessions) {
                        if (!sessionsMap.has(s.sessionId)) {
                            sessionsMap.set(s.sessionId, {
                                sessionId: s.sessionId,
                                cwd: s.cwd ?? "/tmp/test",
                                startedAt: Date.now(),
                            });
                        }
                    }
                }
                // Announce services after registration (like real daemon)
                if (opts?.serviceIds && opts.serviceIds.length > 0) {
                    (socket as any).emit("service_announce", {
                        serviceIds: opts.serviceIds,
                        ...(opts.panels && opts.panels.length > 0 ? { panels: opts.panels } : {}),
                    });
                }
                resolve();
            });
        });

        socket.once("error", (data: { message: string }) => {
            settle(() => reject(new Error(`Server error during registration: ${data.message}`)));
        });
    });

    // ── Register event handlers (mimics real daemon) ──────────────────

    // --- Connection lifecycle (disconnect, error) ---
    socket.on("disconnect", (_reason) => {
        // Real daemon logs and relies on socket.io auto-reconnect.
        // Mock does nothing (reconnection: false).
    });

    // --- Session Management ---

    socket.on("new_session", (data: any) => {
        if (isShuttingDown) return;
        const { sessionId, cwd, prompt, model, agent } = data;

        if (!sessionId) {
            socket.emit("session_error", { sessionId: sessionId ?? "", message: "Missing sessionId" });
            return;
        }

        const session: MockRunnerSession = {
            sessionId,
            cwd: cwd ?? "/tmp/test",
            model,
            agent,
            prompt,
            startedAt: Date.now(),
        };
        sessionsMap.set(sessionId, session);

        // Simulate a short spawn delay, then emit session_ready
        setTimeout(() => {
            if (sessionsMap.has(sessionId)) {
                socket.emit("session_ready", { sessionId });
            }
        }, 10);
    });

    socket.on("kill_session", (data: any) => {
        if (isShuttingDown) return;
        const { sessionId } = data;
        sessionsMap.delete(sessionId);
        socket.emit("session_killed", { sessionId });
    });

    socket.on("session_ended", (data: any) => {
        if (isShuttingDown) return;
        const { sessionId, reason } = data;
        // Handle reconnect case gracefully (like real daemon)
        if (reason === "Session reconnected") return;
        sessionsMap.delete(sessionId);
    });

    socket.on("list_sessions", () => {
        if (isShuttingDown) return;
        (socket as any).emit("sessions_list", {
            sessions: Array.from(sessionsMap.keys()),
        });
    });

    // --- Daemon Control ---

    socket.on("restart", () => {
        if (isShuttingDown) return;
        restartRequested = true;
    });

    socket.on("shutdown", () => {
        if (isShuttingDown) return;
        shutdownRequested = true;
    });

    socket.on("ping", () => {
        if (isShuttingDown) return;
        (socket as any).emit("pong", { now: Date.now() });
    });

    // --- Terminal PTY Management ---

    socket.on("new_terminal", (data: any) => {
        if (isShuttingDown) return;
        const { terminalId, cwd, cols, rows } = data;

        if (!terminalId) {
            socket.emit("terminal_error", { terminalId: "", message: "Missing terminalId" });
            return;
        }

        const terminal: MockTerminal = {
            terminalId,
            cwd: cwd ?? "/tmp/test",
            cols: cols ?? 80,
            rows: rows ?? 24,
            inputBuffer: [],
        };
        terminalsMap.set(terminalId, terminal);

        // Simulate spawn delay then emit terminal_ready
        setTimeout(() => {
            if (terminalsMap.has(terminalId)) {
                (socket as any).emit("terminal_ready", { terminalId });
            }
        }, 10);
    });

    socket.on("terminal_input", (data: any) => {
        if (isShuttingDown) return;
        const { terminalId, data: inputData } = data;
        if (!terminalId || !inputData) return;
        const terminal = terminalsMap.get(terminalId);
        if (terminal) {
            terminal.inputBuffer.push(inputData);
            // Optionally echo back
            (socket as any).emit("terminal_output", { terminalId, data: inputData });
        }
    });

    socket.on("terminal_resize", (data: any) => {
        if (isShuttingDown) return;
        const { terminalId, cols, rows } = data;
        if (!terminalId) return;
        const terminal = terminalsMap.get(terminalId);
        if (terminal) {
            terminal.cols = cols ?? terminal.cols;
            terminal.rows = rows ?? terminal.rows;
        }
    });

    socket.on("kill_terminal", (data: any) => {
        if (isShuttingDown) return;
        const { terminalId } = data;
        if (!terminalId) return;
        if (terminalsMap.has(terminalId)) {
            terminalsMap.delete(terminalId);
            socket.emit("terminal_exit", { terminalId, exitCode: -1 });
        } else {
            socket.emit("terminal_error", { terminalId, message: "Terminal not found" });
        }
    });

    socket.on("list_terminals", () => {
        if (isShuttingDown) return;
        (socket as any).emit("terminals_list", {
            terminals: Array.from(terminalsMap.keys()),
        });
    });

    // --- Skills CRUD ---

    socket.on("list_skills", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        const skills = Array.from(skillsMap.values()).map(({ content: _, ...s }) => s);
        socket.emit("skills_list", { skills, requestId });
    });

    socket.on("create_skill", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        const skillName = (data?.name ?? "").trim();
        const skillContent = data?.content ?? "";

        if (!skillName) {
            socket.emit("skill_result", { requestId, ok: false, message: "Missing skill name" });
            return;
        }
        if (!isValidSkillOrAgentName(skillName)) {
            socket.emit("skill_result", {
                requestId,
                ok: false,
                message: "Invalid skill name: must be lowercase letters, numbers, and hyphens only",
            });
            return;
        }

        skillsMap.set(skillName, {
            name: skillName,
            description: "",
            filePath: `~/.pizzapi/skills/${skillName}.md`,
            content: skillContent,
        });
        const skills = Array.from(skillsMap.values()).map(({ content: _, ...s }) => s);
        socket.emit("skill_result", { requestId, ok: true, skills });
    });

    socket.on("update_skill", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        const skillName = (data?.name ?? "").trim();
        const skillContent = data?.content ?? "";

        if (!skillName) {
            socket.emit("skill_result", { requestId, ok: false, message: "Missing skill name" });
            return;
        }
        if (!isValidSkillOrAgentName(skillName)) {
            socket.emit("skill_result", {
                requestId,
                ok: false,
                message: "Invalid skill name: must be lowercase letters, numbers, and hyphens only",
            });
            return;
        }

        const existing = skillsMap.get(skillName);
        skillsMap.set(skillName, {
            name: skillName,
            description: existing?.description ?? "",
            filePath: existing?.filePath ?? `~/.pizzapi/skills/${skillName}.md`,
            content: skillContent,
        });
        const skills = Array.from(skillsMap.values()).map(({ content: _, ...s }) => s);
        socket.emit("skill_result", { requestId, ok: true, skills });
    });

    socket.on("delete_skill", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        const skillName = (data?.name ?? "").trim();

        if (!skillName) {
            socket.emit("skill_result", { requestId, ok: false, message: "Missing skill name" });
            return;
        }

        const deleted = skillsMap.delete(skillName);
        const skills = Array.from(skillsMap.values()).map(({ content: _, ...s }) => s);
        socket.emit("skill_result", {
            requestId,
            ok: deleted,
            message: deleted ? undefined : "Skill not found",
            skills,
        });
    });

    socket.on("get_skill", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        const skillName = (data?.name ?? "").trim();
        const skill = skillName ? skillsMap.get(skillName) : undefined;

        if (!skill) {
            socket.emit("skill_result", { requestId, ok: false, message: "Skill not found" });
        } else {
            socket.emit("skill_result", {
                requestId,
                ok: true,
                name: skillName,
                content: skill.content ?? `# ${skillName}\n\nSkill content placeholder.`,
            });
        }
    });

    // --- Agents CRUD ---

    socket.on("list_agents", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        const agents = Array.from(agentsMap.values()).map(({ content: _, ...a }) => a);
        socket.emit("agents_list", { agents, requestId });
    });

    socket.on("create_agent", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        const agentName = (data?.name ?? "").trim();
        const agentContent = data?.content ?? "";

        if (!agentName) {
            socket.emit("agent_result", { requestId, ok: false, message: "Missing agent name" });
            return;
        }
        if (!isValidSkillOrAgentName(agentName)) {
            socket.emit("agent_result", {
                requestId,
                ok: false,
                message: "Invalid agent name: must be lowercase letters, numbers, and hyphens only",
            });
            return;
        }

        agentsMap.set(agentName, {
            name: agentName,
            description: "",
            filePath: `~/.pizzapi/agents/${agentName}.md`,
            content: agentContent,
        });
        const agents = Array.from(agentsMap.values()).map(({ content: _, ...a }) => a);
        socket.emit("agent_result", { requestId, ok: true, agents });
    });

    socket.on("update_agent", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        const agentName = (data?.name ?? "").trim();
        const agentContent = data?.content ?? "";

        if (!agentName) {
            socket.emit("agent_result", { requestId, ok: false, message: "Missing agent name" });
            return;
        }
        // Relaxed validation for updates (matches real daemon)
        if (!isValidAgentUpdateName(agentName)) {
            socket.emit("agent_result", {
                requestId,
                ok: false,
                message: "Invalid agent name: must start with a letter or digit and contain only letters, digits, hyphens, underscores, or dots",
            });
            return;
        }

        const existing = agentsMap.get(agentName);
        agentsMap.set(agentName, {
            name: agentName,
            description: existing?.description ?? "",
            filePath: existing?.filePath ?? `~/.pizzapi/agents/${agentName}.md`,
            content: agentContent,
        });
        const agents = Array.from(agentsMap.values()).map(({ content: _, ...a }) => a);
        socket.emit("agent_result", { requestId, ok: true, agents });
    });

    socket.on("delete_agent", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        const agentName = (data?.name ?? "").trim();

        if (!agentName) {
            socket.emit("agent_result", { requestId, ok: false, message: "Missing agent name" });
            return;
        }

        const deleted = agentsMap.delete(agentName);
        const agents = Array.from(agentsMap.values()).map(({ content: _, ...a }) => a);
        socket.emit("agent_result", {
            requestId,
            ok: deleted,
            message: deleted ? undefined : "Agent not found",
            agents,
        });
    });

    socket.on("get_agent", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        const agentName = (data?.name ?? "").trim();
        const agent = agentName ? agentsMap.get(agentName) : undefined;

        if (!agent) {
            socket.emit("agent_result", { requestId, ok: false, message: "Agent not found" });
        } else {
            socket.emit("agent_result", {
                requestId,
                ok: true,
                name: agentName,
                content: agent.content ?? `# ${agentName}\n\nAgent definition placeholder.`,
            });
        }
    });

    // --- Plugins ---

    socket.on("list_plugins", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        socket.emit("plugins_list", { plugins: pluginsList, requestId });
    });

    // --- File Explorer ---

    socket.on("list_files", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        const dirPath = data?.path ?? "";

        if (!dirPath) {
            socket.emit("file_result", { requestId, ok: false, message: "Missing path" });
            return;
        }

        const entries = mockFiles.get(dirPath);
        if (!entries) {
            socket.emit("file_result", { requestId, ok: false, message: `ENOENT: no such directory '${dirPath}'` });
            return;
        }

        // Sort: directories first, then alphabetically (matches real daemon)
        const sorted = [...entries]
            .map(({ content: _, ...e }) => e)
            .sort((a, b) => {
                if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
            });

        socket.emit("file_result", { requestId, ok: true, files: sorted });
    });

    socket.on("search_files", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        const query = (data?.query ?? "").toLowerCase();
        const limit = typeof data?.limit === "number" ? data.limit : 100;

        if (!query) {
            socket.emit("file_result", { requestId, ok: true, files: [] });
            return;
        }

        const allFiles = getAllMockFiles().filter((f) => !f.isDirectory);
        const matching = allFiles
            .filter((f) => f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query))
            .slice(0, limit)
            .map(({ content: _, ...e }) => e);

        socket.emit("file_result", { requestId, ok: true, files: matching });
    });

    socket.on("read_file", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        const filePath = data?.path ?? "";

        if (!filePath) {
            socket.emit("file_result", { requestId, ok: false, message: "Missing path" });
            return;
        }

        // Search all mock file entries for matching path
        let found: MockFileEntry | undefined;
        for (const entries of mockFiles.values()) {
            found = entries.find((e) => e.path === filePath && !e.isDirectory);
            if (found) break;
        }

        if (!found) {
            socket.emit("file_result", { requestId, ok: false, message: `ENOENT: no such file '${filePath}'` });
            return;
        }

        const content = found.content ?? "";
        socket.emit("file_result", {
            requestId,
            ok: true,
            content,
            size: found.size ?? content.length,
            truncated: false,
        });
    });

    // --- Git Operations ---

    socket.on("git_status", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        const cwd = data?.cwd ?? "";

        if (!cwd) {
            socket.emit("file_result", { requestId, ok: false, message: "Missing cwd" });
            return;
        }

        socket.emit("file_result", {
            requestId,
            ok: true,
            branch: gitStatus.branch,
            changes: gitStatus.changes,
            ahead: gitStatus.ahead,
            behind: gitStatus.behind,
            diffStaged: gitStatus.diffStaged,
        });
    });

    socket.on("git_diff", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        const cwd = data?.cwd ?? "";
        const filePath = data?.path ?? "";

        if (!cwd || !filePath) {
            socket.emit("file_result", { requestId, ok: false, message: "Missing cwd or path" });
            return;
        }

        // Return a mock diff for any file in the git changes list
        const change = gitStatus.changes.find((c) => c.path === filePath);
        const diff = change
            ? `diff --git a/${filePath} b/${filePath}\nindex abc1234..def5678 100644\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1,3 +1,3 @@\n-old line\n+new line`
            : "";

        socket.emit("file_result", { requestId, ok: true, diff });
    });

    // --- Sandbox ---

    socket.on("sandbox_get_status", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;

        socket.emit("file_result", {
            requestId,
            ok: true,
            mode: sandboxConfig.mode,
            active: sandboxConfig.active,
            configured: sandboxConfig.configured,
            platform: sandboxConfig.platform,
            violations: sandboxConfig.violations,
            recentViolations: sandboxConfig.recentViolations,
            config: sandboxConfig.config,
            rawConfig: sandboxConfig.rawConfig,
        });
    });

    socket.on("sandbox_update_config", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId;
        const body = data?.config;

        if (!body || typeof body !== "object") {
            socket.emit("file_result", { requestId, ok: false, message: "Invalid sandbox config body" });
            return;
        }

        const validModes = ["none", "basic", "full"];
        if (body.mode !== undefined && !validModes.includes(body.mode)) {
            socket.emit("file_result", { requestId, ok: false, message: `Invalid mode "${body.mode}"` });
            return;
        }

        // Merge config
        sandboxConfig = {
            ...sandboxConfig,
            ...(body.mode !== undefined ? { mode: body.mode, configured: body.mode !== "none", active: body.mode !== "none" } : {}),
            config: { ...sandboxConfig.config, ...body },
            rawConfig: { ...sandboxConfig.rawConfig, ...body },
        };

        socket.emit("file_result", {
            requestId,
            ok: true,
            saved: true,
            resolvedConfig: sandboxConfig.config,
            message: "Changes will apply on next session start.",
        });
    });

    // --- Tunnel proxy (via @pizzapi/tunnel TunnelClient) ---
    // Connects to the server's /_tunnel WebSocket endpoint and proxies
    // HTTP requests to local ports (service panel iframes).

    let tunnelClient: import("@pizzapi/tunnel").TunnelClient | null = null;
    if (opts?.panels && opts.panels.length > 0) {
        const { TunnelClient } = await import("@pizzapi/tunnel");
        const wsUrl = server.baseUrl.replace(/^http/, "ws") + "/_tunnel";
        tunnelClient = new TunnelClient({
            runnerId: assignedRunnerId,
            apiKey: opts?.apiKey ?? server.apiKey,
            relayUrl: wsUrl,
            autoReconnect: false,
            log: { info() {}, debug() {}, error() {}, warn() {} },
        });
        for (const p of opts.panels) {
            tunnelClient.exposePort(p.port);
        }
        const registered = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("TunnelClient registration timed out")), 5_000);
            tunnelClient!.once("registered", () => { clearTimeout(timeout); resolve(); });
            tunnelClient!.once("error", (err: Error) => { clearTimeout(timeout); reject(err); });
        });
        tunnelClient.connect();
        await registered;
    }

    // --- Usage ---

    socket.on("get_usage", (data: any) => {
        if (isShuttingDown) return;
        const requestId = data?.requestId ?? "";

        socket.emit("usage_data", { requestId, data: usageData });
    });

    // --- Error handling ---

    socket.on("error", (_data: any) => {
        // Real daemon logs the error. Mock does nothing.
    });

    // ── MockRunner implementation ─────────────────────────────────────

    const runner: MockRunner = {
        runnerId: assignedRunnerId,
        socket,

        get sessions(): ReadonlyMap<string, MockRunnerSession> {
            return sessionsMap;
        },

        get terminals(): ReadonlyMap<string, MockTerminal> {
            return terminalsMap;
        },

        get skills(): RunnerSkill[] {
            return Array.from(skillsMap.values()).map(({ content: _, ...s }) => s);
        },

        get agents(): RunnerAgent[] {
            return Array.from(agentsMap.values()).map(({ content: _, ...a }) => a);
        },

        emitSessionReady(sessionId: string): void {
            socket.emit("session_ready", { sessionId });
        },

        emitSessionError(sessionId: string, error: string): void {
            socket.emit("session_error", { sessionId, message: error });
        },

        emitSessionEvent(sessionId: string, event: unknown): void {
            socket.emit("runner_session_event", { sessionId, event });
        },

        emitSessionEnded(sessionId: string): void {
            socket.emit("session_killed", { sessionId });
        },

        getSession(sessionId: string): MockRunnerSession | undefined {
            return sessionsMap.get(sessionId);
        },

        getTerminal(terminalId: string): MockTerminal | undefined {
            return terminalsMap.get(terminalId);
        },

        wasRestartRequested(): boolean {
            return restartRequested;
        },

        wasShutdownRequested(): boolean {
            return shutdownRequested;
        },

        announceServices(serviceIds: string[], panels?: ServicePanelInfo[]): void {
            (socket as any).emit("service_announce", {
                serviceIds,
                ...(panels && panels.length > 0 ? { panels } : {}),
            });
        },

        onSkillRequest(handler: (data: unknown) => unknown): void {
            // Remove built-in list_skills handler and replace with custom
            socket.off("list_skills");
            socket.on("list_skills", (data) => {
                const result = handler(data);
                socket.emit("skills_list", {
                    skills: Array.isArray(result) ? result : [],
                    requestId: (data as { requestId?: string }).requestId,
                });
            });
        },

        onFileRequest(handler: (data: unknown) => unknown): void {
            // Remove built-in list_files handler and replace with custom
            socket.off("list_files");
            socket.on("list_files", (data) => {
                const result = handler(data);
                socket.emit("file_result", {
                    ...(typeof result === "object" && result !== null ? result : {}),
                    requestId: (data as { requestId?: string }).requestId,
                });
            });
        },

        waitForEvent(eventName: string, timeout = 5_000): Promise<unknown> {
            return new Promise<unknown>((resolve, reject) => {
                const handler = (data: unknown): void => {
                    clearTimeout(timer);
                    resolve(data);
                };

                const timer = setTimeout(() => {
                    socket.off(eventName, handler);
                    reject(new Error(`Timed out waiting for event "${eventName}" after ${timeout}ms`));
                }, timeout);

                socket.once(eventName, handler);
            });
        },

        async disconnect(): Promise<void> {
            isShuttingDown = true;
            tunnelClient?.dispose();
            tunnelClient = null;
            if (!socket.connected) return;
            await new Promise<void>((resolve) => {
                socket.once("disconnect", () => resolve());
                socket.disconnect();
            });
        },
    };

    return runner;
}
