import type { Socket } from "socket.io-client";
import type { ServiceHandler, ServiceInitOptions } from "../service-handler.js";
import {
    spawnTerminal,
    writeTerminalInput,
    resizeTerminal,
    killTerminal,
    killAllTerminals,
    listTerminals,
} from "../terminal.js";
import { isCwdAllowed } from "../workspace.js";
import { logInfo, logWarn, logError } from "../logger.js";

export class TerminalService implements ServiceHandler {
    readonly id = "terminal";

    // Socket reference and named handler refs — kept so dispose() can call
    // socket.off() with the exact same function object that was passed to
    // socket.on().  Without this, each reconnect would add a new listener
    // while the old one stayed registered (listener leak).
    private _socket: Socket | null = null;
    private _onNewTerminal: ((data: any) => void) | null = null;
    private _onTerminalInput: ((data: any) => void) | null = null;
    private _onTerminalResize: ((data: any) => void) | null = null;
    private _onKillTerminal: ((data: any) => void) | null = null;
    private _onListTerminals: (() => void) | null = null;

    init(socket: Socket, { isShuttingDown }: ServiceInitOptions): void {
        this._socket = socket;

        this._onNewTerminal = (data: any) => {
            if (isShuttingDown()) return;
            const { terminalId, cwd: requestedCwd, cols, rows, shell } = data;
            logInfo(
                `[terminal] new_terminal received: terminalId=${terminalId} cwd=${requestedCwd ?? "(default)"} cols=${cols ?? 80} rows=${rows ?? 24} shell=${shell ?? "(default)"}`,
            );
            if (!terminalId) {
                logWarn("[terminal] new_terminal: missing terminalId — rejecting");
                socket.emit("terminal_error", { terminalId: "", message: "Missing terminalId" });
                (socket as any).emit("service_message", {
                    serviceId: "terminal",
                    type: "terminal_error",
                    payload: { terminalId: "", message: "Missing terminalId" },
                });
                return;
            }
            if (requestedCwd && !isCwdAllowed(requestedCwd)) {
                logWarn(
                    `[terminal] new_terminal: cwd="${requestedCwd}" outside allowed roots — rejecting terminalId=${terminalId}`,
                );
                socket.emit("terminal_error", {
                    terminalId,
                    message: `cwd outside allowed roots: ${requestedCwd}`,
                });
                (socket as any).emit("service_message", {
                    serviceId: "terminal",
                    type: "terminal_error",
                    payload: { terminalId, message: `cwd outside allowed roots: ${requestedCwd}` },
                });
                return;
            }
            // The terminal module calls termSend with { type: "terminal_*", ... } payloads.
            // Extract the type field and emit it as a socket.io event.
            // Also dual-emit via service_message envelope for Phase 3 UI hooks.
            const termSend = (payload: Record<string, unknown>) => {
                try {
                    const { type, runnerId: _drop, ...rest } = payload;
                    if (typeof type === "string") {
                        // Existing named event — keeps backward compatibility
                        (socket as any).emit(type, rest);
                        // Also emit via service envelope for useServiceChannel hooks
                        (socket as any).emit("service_message", {
                            serviceId: "terminal",
                            type,
                            payload: rest,
                        });
                    }
                } catch (err) {
                    logError(
                        `[terminal] termSend: failed to send ${payload.type} for terminalId=${terminalId}: ${err}`,
                    );
                }
            };
            spawnTerminal(terminalId, termSend, {
                cwd: requestedCwd,
                cols,
                rows,
                shell,
            });
        };
        socket.on("new_terminal", this._onNewTerminal);

        this._onTerminalInput = (data: any) => {
            if (isShuttingDown()) return;
            const { terminalId, data: inputData } = data;
            if (!terminalId || !inputData) {
                logWarn(
                    `[terminal] terminal_input: missing terminalId or data (terminalId=${terminalId} dataLen=${inputData?.length ?? 0})`,
                );
                return;
            }
            writeTerminalInput(terminalId, inputData);
        };
        socket.on("terminal_input", this._onTerminalInput);

        this._onTerminalResize = (data: any) => {
            if (isShuttingDown()) return;
            const { terminalId, cols, rows } = data;
            if (!terminalId) {
                logWarn("[terminal] terminal_resize: missing terminalId");
                return;
            }
            logInfo(`[terminal] terminal_resize: terminalId=${terminalId} ${cols}x${rows}`);
            resizeTerminal(terminalId, cols, rows);
        };
        socket.on("terminal_resize", this._onTerminalResize);

        this._onKillTerminal = (data: any) => {
            if (isShuttingDown()) return;
            const { terminalId } = data;
            if (!terminalId) {
                logWarn("[terminal] kill_terminal: missing terminalId");
                return;
            }
            logInfo(`[terminal] kill_terminal: terminalId=${terminalId}`);
            const killed = killTerminal(terminalId);
            logInfo(`[terminal] kill_terminal: result=${killed} terminalId=${terminalId}`);
            if (killed) {
                socket.emit("terminal_exit", { terminalId, exitCode: -1 });
                // Dual-emit via service envelope for useServiceChannel hooks
                (socket as any).emit("service_message", {
                    serviceId: "terminal",
                    type: "terminal_exit",
                    payload: { terminalId, exitCode: -1 },
                });
            } else {
                socket.emit("terminal_error", { terminalId, message: "Terminal not found" });
                // Dual-emit via service envelope for useServiceChannel hooks
                (socket as any).emit("service_message", {
                    serviceId: "terminal",
                    type: "terminal_error",
                    payload: { terminalId, message: "Terminal not found" },
                });
            }
        };
        socket.on("kill_terminal", this._onKillTerminal);

        this._onListTerminals = () => {
            if (isShuttingDown()) return;
            const list = listTerminals();
            logInfo(`[terminal] list_terminals: ${list.length} active (${list.join(", ") || "none"})`);
            // terminals_list is not in the typed protocol yet — emit untyped
            (socket as any).emit("terminals_list", { terminals: list });
            // Dual-emit via service envelope for useServiceChannel hooks
            (socket as any).emit("service_message", {
                serviceId: "terminal",
                type: "terminals_list",
                payload: { terminals: list },
            });
        };
        socket.on("list_terminals", this._onListTerminals);
    }

    dispose(): void {
        // Remove all socket listeners registered by init() so that reconnects
        // don't accumulate N+1 handlers per event.
        if (this._socket) {
            if (this._onNewTerminal) (this._socket as any).off("new_terminal", this._onNewTerminal);
            if (this._onTerminalInput) (this._socket as any).off("terminal_input", this._onTerminalInput);
            if (this._onTerminalResize) (this._socket as any).off("terminal_resize", this._onTerminalResize);
            if (this._onKillTerminal) (this._socket as any).off("kill_terminal", this._onKillTerminal);
            if (this._onListTerminals) (this._socket as any).off("list_terminals", this._onListTerminals);
            this._socket = null;
        }
        this._onNewTerminal = null;
        this._onTerminalInput = null;
        this._onTerminalResize = null;
        this._onKillTerminal = null;
        this._onListTerminals = null;
        killAllTerminals();
    }
}
