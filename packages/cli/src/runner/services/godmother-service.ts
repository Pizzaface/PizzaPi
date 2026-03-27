import type { Socket } from "socket.io-client";
import { loadConfig } from "../../config.js";
import { createStdioMcpClient } from "../../extensions/mcp/transport-stdio.js";
import type { McpCallToolResult, McpClient } from "../../extensions/mcp/types.js";
import type { ServiceEnvelope, ServiceHandler, ServiceInitOptions } from "../service-handler.js";

type JsonRecord = Record<string, unknown>;

type SessionServiceEnvelope = ServiceEnvelope & { sessionId?: string };

export interface GodmotherMcpConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
}

interface GodmotherServiceDeps {
    resolveConfig?: () => GodmotherMcpConfig | null;
    createClient?: (config: GodmotherMcpConfig) => Promise<McpClient>;
}

interface IdeasQueryPayload {
    query?: string;
    status?: string;
    topic?: string;
    includeCompleted?: boolean;
    limit?: number;
    project?: string;
}

interface MoveStatusPayload {
    id?: string;
    to?: string;
}

interface AddTopicsPayload {
    id?: string;
    topics?: unknown;
}

interface GodmotherIdea {
    id: string;
    project: string;
    status: string;
    topics: string[];
    snippet: string;
    created?: string;
    updated?: string;
    score?: number;
}

const GODMOTHER_SERVICE_ID = "godmother";
const DEFAULT_PROJECT = "PizzaPi";
const DEFAULT_LIMIT = 60;

const IDEA_STATUSES = new Set([
    "capture",
    "triage",
    "design",
    "plan",
    "execute",
    "review",
    "shipped",
]);

function isRecord(value: unknown): value is JsonRecord {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function readTrimmed(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0);
}

function normalizeTopicsInput(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value
            .flatMap((item) => (typeof item === "string" ? item.split(",") : []))
            .map((item) => item.trim().toLowerCase().replace(/\s+/g, "-"))
            .filter((item) => item.length > 0);
    }
    if (typeof value === "string") {
        return value
            .split(",")
            .map((item) => item.trim().toLowerCase().replace(/\s+/g, "-"))
            .filter((item) => item.length > 0);
    }
    return [];
}

function clampLimit(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return DEFAULT_LIMIT;
    return Math.max(1, Math.min(200, Math.floor(n)));
}

export function resolveGodmotherMcpConfig(rawConfig: unknown): GodmotherMcpConfig | null {
    if (!isRecord(rawConfig)) return null;

    if (isRecord(rawConfig.mcp) && Array.isArray(rawConfig.mcp.servers)) {
        for (const entry of rawConfig.mcp.servers) {
            if (!isRecord(entry)) continue;
            if (entry.name !== GODMOTHER_SERVICE_ID) continue;
            if (entry.transport !== "stdio") continue;
            if (typeof entry.command !== "string" || entry.command.trim().length === 0) continue;

            const args = Array.isArray(entry.args)
                ? entry.args.filter((arg): arg is string => typeof arg === "string")
                : undefined;
            const env = isRecord(entry.env)
                ? Object.fromEntries(Object.entries(entry.env).filter(([, val]) => typeof val === "string")) as Record<string, string>
                : undefined;
            const cwd = typeof entry.cwd === "string" ? entry.cwd : undefined;

            return {
                command: entry.command,
                ...(args ? { args } : {}),
                ...(env ? { env } : {}),
                ...(cwd ? { cwd } : {}),
            };
        }
    }

    if (!isRecord(rawConfig.mcpServers)) return null;
    const compat = rawConfig.mcpServers[GODMOTHER_SERVICE_ID];
    if (!isRecord(compat)) return null;
    if (typeof compat.command !== "string" || compat.command.trim().length === 0) return null;

    const args = Array.isArray(compat.args)
        ? compat.args.filter((arg): arg is string => typeof arg === "string")
        : undefined;
    const env = isRecord(compat.env)
        ? Object.fromEntries(Object.entries(compat.env).filter(([, val]) => typeof val === "string")) as Record<string, string>
        : undefined;
    const cwd = typeof compat.cwd === "string" ? compat.cwd : undefined;

    return {
        command: compat.command,
        ...(args ? { args } : {}),
        ...(env ? { env } : {}),
        ...(cwd ? { cwd } : {}),
    };
}

function extractToolError(result: McpCallToolResult): string {
    const parsed = parseGodmotherToolResult(result);
    if (typeof parsed === "string" && parsed.trim().length > 0) return parsed;
    if (isRecord(parsed) && typeof parsed.error === "string") return parsed.error;
    return "Godmother MCP call failed";
}

export function parseGodmotherToolResult(result: McpCallToolResult): unknown {
    const content = Array.isArray(result.content) ? result.content : [];
    const textParts = content
        .filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
        .map((item) => String(item.text).trim())
        .filter((item) => item.length > 0);

    if (textParts.length === 0) {
        return result.content;
    }

    const joined = textParts.join("\n");
    try {
        return JSON.parse(joined);
    } catch {
        return joined;
    }
}

function normalizeIdea(raw: unknown): GodmotherIdea | null {
    if (!isRecord(raw)) return null;
    const id = readTrimmed(raw.id);
    const status = readTrimmed(raw.status);
    if (!id || !status) return null;

    const content = readString(raw.content)?.trim();
    const snippet = readString(raw.snippet)?.trim();

    return {
        id,
        status,
        project: readTrimmed(raw.project) ?? DEFAULT_PROJECT,
        topics: asStringArray(raw.topics),
        snippet: (snippet && snippet.length > 0 ? snippet : content) ?? "(no details)",
        ...(readString(raw.created) ? { created: String(raw.created) } : {}),
        ...(readString(raw.updated) ? { updated: String(raw.updated) } : {}),
        ...(typeof raw.score === "number" && Number.isFinite(raw.score) ? { score: raw.score } : {}),
    };
}

export class GodmotherService implements ServiceHandler {
    readonly id = GODMOTHER_SERVICE_ID;

    private socket: Socket | null = null;
    private onServiceMessage: ((envelope: SessionServiceEnvelope) => void) | null = null;
    private client: McpClient | null = null;
    private clientPromise: Promise<McpClient> | null = null;

    private readonly resolveConfig: () => GodmotherMcpConfig | null;
    private readonly createClient: (config: GodmotherMcpConfig) => Promise<McpClient>;

    constructor(deps: GodmotherServiceDeps = {}) {
        this.resolveConfig = deps.resolveConfig ?? (() => resolveGodmotherMcpConfig(loadConfig()));
        this.createClient = deps.createClient ?? ((config) =>
            createStdioMcpClient({
                name: GODMOTHER_SERVICE_ID,
                command: config.command,
                args: config.args,
                env: config.env,
                cwd: config.cwd,
            }));
    }

    isConfigured(): boolean {
        return this.resolveConfig() !== null;
    }

    init(socket: Socket, { isShuttingDown }: ServiceInitOptions): void {
        this.socket = socket;
        this.onServiceMessage = (envelope: SessionServiceEnvelope) => {
            if (isShuttingDown()) return;
            if (envelope.serviceId !== GODMOTHER_SERVICE_ID) return;

            void this.handleEnvelope(envelope).catch((err) => {
                this.emitError(
                    err instanceof Error ? err.message : String(err),
                    envelope.requestId,
                    envelope.sessionId,
                );
            });
        };

        (socket as any).on("service_message", this.onServiceMessage);
    }

    dispose(): void {
        if (this.socket && this.onServiceMessage) {
            (this.socket as any).off("service_message", this.onServiceMessage);
        }
        this.socket = null;
        this.onServiceMessage = null;

        if (this.client) {
            try {
                this.client.close();
            } catch {
                // ignore close errors
            }
        }

        this.client = null;
        this.clientPromise = null;
    }

    private async ensureClient(): Promise<McpClient> {
        if (this.client) return this.client;
        if (this.clientPromise) return this.clientPromise;

        const config = this.resolveConfig();
        if (!config) {
            throw new Error("Godmother MCP server is not configured on this runner.");
        }

        this.clientPromise = this.createClient(config)
            .then(async (client) => {
                await client.initialize();
                this.client = client;
                return client;
            })
            .catch((err) => {
                this.clientPromise = null;
                throw err;
            });

        return this.clientPromise;
    }

    private emit(type: string, payload: unknown, requestId?: string, sessionId?: string): void {
        if (!this.socket) return;
        const envelope: SessionServiceEnvelope = {
            serviceId: GODMOTHER_SERVICE_ID,
            type,
            payload,
            ...(requestId ? { requestId } : {}),
            ...(sessionId ? { sessionId } : {}),
        };
        (this.socket as any).emit("service_message", envelope);
    }

    private emitError(error: string, requestId?: string, sessionId?: string): void {
        this.emit("godmother_error", { error }, requestId, sessionId);
    }

    private async callToolJson(toolName: string, args: JsonRecord): Promise<unknown> {
        const client = await this.ensureClient();
        const result = await client.callTool(toolName, args);
        if (result.isError) {
            throw new Error(extractToolError(result));
        }
        return parseGodmotherToolResult(result);
    }

    private async handleEnvelope(envelope: SessionServiceEnvelope): Promise<void> {
        switch (envelope.type) {
            case "ideas_query":
                await this.handleIdeasQuery(envelope);
                return;
            case "idea_move_status":
                await this.handleMoveStatus(envelope);
                return;
            case "idea_add_topics":
                await this.handleAddTopics(envelope);
                return;
            default:
                this.emitError(`Unknown Godmother request type: ${envelope.type}`, envelope.requestId, envelope.sessionId);
        }
    }

    private async handleIdeasQuery(envelope: SessionServiceEnvelope): Promise<void> {
        const payload = isRecord(envelope.payload) ? envelope.payload as IdeasQueryPayload : {};

        const query = readTrimmed(payload.query);
        const status = readTrimmed(payload.status);
        const topic = readTrimmed(payload.topic)?.toLowerCase();
        const project = readTrimmed(payload.project) ?? DEFAULT_PROJECT;
        const includeCompleted = payload.includeCompleted === true;
        const limit = clampLimit(payload.limit);

        const raw = query
            ? await this.callToolJson("search_ideas", {
                query,
                project,
                ...(status ? { status } : {}),
                limit,
            })
            : await this.callToolJson("list_ideas", {
                project,
                ...(status ? { status } : {}),
                ...(topic ? { topics: [topic] } : {}),
                include_completed: includeCompleted,
            });

        const ideas = Array.isArray(raw) ? raw.map(normalizeIdea).filter((idea): idea is GodmotherIdea => idea !== null) : [];

        const filtered = topic
            ? ideas.filter((idea) => idea.topics.some((t) => t.toLowerCase() === topic))
            : ideas;

        const sorted = filtered
            .sort((a, b) => {
                const aTime = Date.parse(a.updated ?? a.created ?? "");
                const bTime = Date.parse(b.updated ?? b.created ?? "");
                if (Number.isFinite(aTime) && Number.isFinite(bTime)) {
                    return bTime - aTime;
                }
                return a.id.localeCompare(b.id);
            })
            .slice(0, limit);

        this.emit(
            "godmother_query_result",
            {
                ideas: sorted,
                query: query ?? "",
                status: status ?? "",
                topic: topic ?? "",
                project,
            },
            envelope.requestId,
            envelope.sessionId,
        );
    }

    private async handleMoveStatus(envelope: SessionServiceEnvelope): Promise<void> {
        const payload = isRecord(envelope.payload) ? envelope.payload as MoveStatusPayload : {};
        const id = readTrimmed(payload.id);
        const to = readTrimmed(payload.to);

        if (!id || !to) {
            throw new Error("idea_move_status requires id and to.");
        }
        if (!IDEA_STATUSES.has(to)) {
            throw new Error(`Invalid Godmother status: ${to}`);
        }

        await this.callToolJson("move_idea", { id, to });
        const rawIdea = await this.callToolJson("get_idea", { id });
        const idea = normalizeIdea(rawIdea);

        if (!idea) {
            throw new Error(`Failed to load updated idea: ${id}`);
        }

        this.emit(
            "godmother_idea_updated",
            { idea },
            envelope.requestId,
            envelope.sessionId,
        );
    }

    private async handleAddTopics(envelope: SessionServiceEnvelope): Promise<void> {
        const payload = isRecord(envelope.payload) ? envelope.payload as AddTopicsPayload : {};
        const id = readTrimmed(payload.id);

        if (!id) {
            throw new Error("idea_add_topics requires id.");
        }

        const requestedTopics = normalizeTopicsInput(payload.topics);
        if (requestedTopics.length === 0) {
            throw new Error("No valid topics provided.");
        }

        const rawIdea = await this.callToolJson("get_idea", { id });
        const currentIdea = normalizeIdea(rawIdea);
        if (!currentIdea) {
            throw new Error(`Idea not found: ${id}`);
        }

        const mergedTopics = [...new Set([...currentIdea.topics, ...requestedTopics])].sort((a, b) => a.localeCompare(b));
        await this.callToolJson("update_idea", { id, topics: mergedTopics });

        const freshRaw = await this.callToolJson("get_idea", { id });
        const freshIdea = normalizeIdea(freshRaw);
        if (!freshIdea) {
            throw new Error(`Failed to load updated idea: ${id}`);
        }

        this.emit(
            "godmother_idea_updated",
            { idea: freshIdea },
            envelope.requestId,
            envelope.sessionId,
        );
    }
}
