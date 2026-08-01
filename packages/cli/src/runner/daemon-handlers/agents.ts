// Agents management socket.io handlers, split out of daemon.ts's runDaemon().
import type { Socket } from "socket.io-client";
import { scanGlobalAgents, readAgentContent, writeAgent, deleteAgent } from "../../agents.js";

export function registerAgentsHandlers(socket: Socket, isShuttingDown: () => boolean): void {
    socket.on("list_agents", (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data.requestId;
        const agents = scanGlobalAgents();
        socket.emit("agents_list", { agents, requestId });
    });

    socket.on("create_agent", async (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data.requestId;
        const agentName = (data.name ?? "").trim();
        const agentContent = data.content ?? "";

        if (!agentName) {
            socket.emit("agent_result", { requestId, ok: false, message: "Missing agent name" });
            return;
        }

        if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(agentName) && !/^[a-z0-9]$/.test(agentName)) {
            socket.emit("agent_result", {
                requestId,
                ok: false,
                message: "Invalid agent name: must be lowercase letters, numbers, and hyphens only",
            });
            return;
        }

        try {
            await writeAgent(agentName, agentContent);
            const agents = scanGlobalAgents();
            socket.emit("agent_result", { requestId, ok: true, agents });
        } catch (err) {
            socket.emit("agent_result", {
                requestId,
                ok: false,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    });

    socket.on("update_agent", async (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data.requestId;
        const agentName = (data.name ?? "").trim();
        const agentContent = data.content ?? "";

        if (!agentName) {
            socket.emit("agent_result", { requestId, ok: false, message: "Missing agent name" });
            return;
        }

        // Relaxed validation for updates: accept any name the scanner
        // can discover (letters, digits, hyphens, underscores, dots)
        // but reject path separators to prevent directory traversal.
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(agentName)) {
            socket.emit("agent_result", {
                requestId,
                ok: false,
                message: "Invalid agent name: must start with a letter or digit and contain only letters, digits, hyphens, underscores, or dots",
            });
            return;
        }

        try {
            await writeAgent(agentName, agentContent);
            const agents = scanGlobalAgents();
            socket.emit("agent_result", { requestId, ok: true, agents });
        } catch (err) {
            socket.emit("agent_result", {
                requestId,
                ok: false,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    });

    socket.on("delete_agent", (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data.requestId;
        const agentName = (data.name ?? "").trim();

        if (!agentName) {
            socket.emit("agent_result", { requestId, ok: false, message: "Missing agent name" });
            return;
        }

        const deleted = deleteAgent(agentName);
        const agents = scanGlobalAgents();
        socket.emit("agent_result", {
            requestId,
            ok: deleted,
            message: deleted ? undefined : "Agent not found",
            agents,
        });
    });

    socket.on("get_agent", (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data.requestId;
        const agentName = (data.name ?? "").trim();
        const content = agentName ? readAgentContent(agentName) : null;
        if (content === null) {
            socket.emit("agent_result", { requestId, ok: false, message: "Agent not found" });
        } else {
            socket.emit("agent_result", { requestId, ok: true, name: agentName, content });
        }
    });
}
