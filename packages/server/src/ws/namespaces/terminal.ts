// ============================================================================
// /terminal namespace — Browser terminal viewer ↔ Server
//
// Handles browser terminal viewer connections, forwarding PTY input/resize/kill
// to the runner that owns the terminal, and implementing deferred spawn
// (terminal PTY is spawned on the runner when the viewer sends its first resize).
// ============================================================================

import type { Server as SocketIOServer, Namespace } from "socket.io";
import type {
    TerminalClientToServerEvents,
    TerminalServerToClientEvents,
    TerminalInterServerEvents,
    TerminalSocketData,
} from "@pizzapi/protocol";
import { sessionCookieAuthMiddleware } from "./auth.js";
import {
    getTerminalEntry,
    setTerminalViewer,
    markTerminalSpawned,
    removeTerminalViewer,
    getLocalRunnerSocket,
} from "../sio-registry.js";

export function registerTerminalNamespace(io: SocketIOServer): void {
    const terminal: Namespace<
        TerminalClientToServerEvents,
        TerminalServerToClientEvents,
        TerminalInterServerEvents,
        TerminalSocketData
    > = io.of("/terminal");

    // Auth: validate session cookie from handshake
    terminal.use(sessionCookieAuthMiddleware() as Parameters<typeof terminal.use>[0]);

    terminal.on("connection", async (socket) => {
        // Extract terminalId from handshake auth or query
        const terminalId =
            (typeof socket.handshake.auth?.terminalId === "string"
                ? socket.handshake.auth.terminalId
                : undefined) ??
            (typeof socket.handshake.query?.terminalId === "string"
                ? socket.handshake.query.terminalId
                : undefined) ??
            "";

        if (!terminalId) {
            socket.emit("terminal_error", { terminalId: "", message: "Missing terminal ID" });
            socket.disconnect(true);
            return;
        }

        socket.data.terminalId = terminalId;

        console.log(
            `[sio/terminal] viewer connected: terminalId=${terminalId} userId=${socket.data.userId}`,
        );

        // Validate terminal exists
        const entry = await getTerminalEntry(terminalId);
        if (!entry) {
            console.warn(
                `[sio/terminal] viewer connected but no terminal entry found: terminalId=${terminalId}`,
            );
            socket.emit("terminal_error", { terminalId, message: "Terminal not found" });
            socket.disconnect(true);
            return;
        }

        // Validate user owns the terminal
        if (entry.userId !== socket.data.userId) {
            console.warn(
                `[sio/terminal] viewer forbidden: terminalId=${terminalId} ` +
                    `entry.userId=${entry.userId} viewer.userId=${socket.data.userId}`,
            );
            socket.emit("terminal_error", { terminalId, message: "Forbidden" });
            socket.disconnect(true);
            return;
        }

        // Attach viewer to the terminal (replays buffered messages)
        const attached = await setTerminalViewer(terminalId, socket);
        if (!attached) {
            socket.emit("terminal_error", { terminalId, message: "Terminal not found" });
            socket.disconnect(true);
            return;
        }

        console.log(
            `[sio/terminal] viewer attached to runnerId=${entry.runnerId}: terminalId=${terminalId}`,
        );
        socket.emit("terminal_connected", { terminalId });

        // ── terminal_input — forward input to runner ─────────────────────────
        socket.on("terminal_input", async (data) => {
            const tid = socket.data.terminalId;
            if (!tid) return;

            const te = await getTerminalEntry(tid);
            if (!te) return;

            const runnerSocket = getLocalRunnerSocket(te.runnerId);
            if (!runnerSocket) {
                console.warn(
                    `[sio/terminal] runner not found runnerId=${te.runnerId} for terminalId=${tid} — input dropped`,
                );
                return;
            }

            runnerSocket.emit("terminal_input" as string, {
                terminalId: tid,
                data: data.data,
            });
        });

        // ── terminal_resize — deferred spawn or forward to runner ────────────
        socket.on("terminal_resize", async (data) => {
            const tid = socket.data.terminalId;
            if (!tid) return;

            const te = await getTerminalEntry(tid);
            if (!te) return;

            const runnerSocket = getLocalRunnerSocket(te.runnerId);
            if (!runnerSocket) {
                console.warn(
                    `[sio/terminal] runner not found runnerId=${te.runnerId} for terminalId=${tid} — resize dropped`,
                );
                return;
            }

            // Deferred spawn: if the PTY hasn't been spawned yet and we receive
            // the first terminal_resize from the viewer, use those dimensions to spawn.
            if (!te.spawned) {
                const spawnOpts = JSON.parse(te.spawnOpts) as {
                    cwd?: string;
                    shell?: string;
                    cols?: number;
                    rows?: number;
                };
                const cols =
                    typeof data.cols === "number" && data.cols > 0
                        ? data.cols
                        : (spawnOpts.cols ?? 80);
                const rows =
                    typeof data.rows === "number" && data.rows > 0
                        ? data.rows
                        : (spawnOpts.rows ?? 24);

                console.log(
                    `[sio/terminal] deferred spawn: viewer sent resize → spawning PTY ` +
                        `terminalId=${tid} ${cols}x${rows} cwd=${spawnOpts.cwd ?? "(default)"}`,
                );

                await markTerminalSpawned(tid);

                try {
                    runnerSocket.emit("new_terminal" as string, {
                        terminalId: tid,
                        cwd: spawnOpts.cwd,
                        shell: spawnOpts.shell,
                        cols,
                        rows,
                    });
                } catch (err) {
                    console.error(
                        `[sio/terminal] deferred spawn: failed to send new_terminal to runner ` +
                            `runnerId=${te.runnerId} terminalId=${tid}:`,
                        err,
                    );
                    socket.emit("terminal_error", {
                        terminalId: tid,
                        message: "Failed to spawn terminal",
                    });
                }
                return; // Don't forward the resize — runner uses dims from new_terminal
            }

            // Normal resize: forward to runner
            console.log(
                `[sio/terminal] viewer→runner: terminalId=${tid} terminal_resize cols=${data.cols} rows=${data.rows}`,
            );
            runnerSocket.emit("terminal_resize" as string, {
                terminalId: tid,
                cols: data.cols,
                rows: data.rows,
            });
        });

        // ── kill_terminal — forward to runner ────────────────────────────────
        socket.on("kill_terminal", async (data) => {
            const tid = socket.data.terminalId;
            if (!tid) return;

            const te = await getTerminalEntry(tid);
            if (!te) return;

            const runnerSocket = getLocalRunnerSocket(te.runnerId);
            if (!runnerSocket) return;

            runnerSocket.emit("kill_terminal" as string, { terminalId: tid });
        });

        // ── disconnect ───────────────────────────────────────────────────────
        socket.on("disconnect", async (reason) => {
            const tid = socket.data.terminalId;
            console.log(
                `[sio/terminal] viewer disconnected: terminalId=${tid} userId=${socket.data.userId} (${reason})`,
            );
            if (tid) {
                await removeTerminalViewer(tid, socket);
            }
        });
    });
}
