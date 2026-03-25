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

    init(socket: Socket, { isShuttingDown }: ServiceInitOptions): void {
        socket.on("new_terminal", (data: any) => {
            if (isShuttingDown()) return;
            const { terminalId, cwd: requestedCwd, cols, rows, shell } = data;
            logInfo(
                `[terminal] new_terminal received: terminalId=${terminalId} cwd=${requestedCwd ?? "(default)"} cols=${cols ?? 80} rows=${rows ?? 24} shell=${shell ?? "(default)"}`,
            );
            if (!terminalId) {
                logWarn("[terminal] new_terminal: missing terminalId — rejecting");
                socket.emit("terminal_error", { terminalId: "", message: "Missing terminalId" });
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
                return;
            }
            // The terminal module calls termSend with { type: "terminal_*", ... } payloads.
            // Extract the type field and emit it as a socket.io event.
            const termSend = (payload: Record<string, unknown>) => {
                try {
                    const { type, runnerId: _drop, ...rest } = payload;
                    if (typeof type === "string") {
                        (socket as any).emit(type, rest);
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
        });

        socket.on("terminal_input", (data: any) => {
            if (isShuttingDown()) return;
            const { terminalId, data: inputData } = data;
            if (!terminalId || !inputData) {
                logWarn(
                    `[terminal] terminal_input: missing terminalId or data (terminalId=${terminalId} dataLen=${inputData?.length ?? 0})`,
                );
                return;
            }
            writeTerminalInput(terminalId, inputData);
        });

        socket.on("terminal_resize", (data: any) => {
            if (isShuttingDown()) return;
            const { terminalId, cols, rows } = data;
            if (!terminalId) {
                logWarn("[terminal] terminal_resize: missing terminalId");
                return;
            }
            logInfo(`[terminal] terminal_resize: terminalId=${terminalId} ${cols}x${rows}`);
            resizeTerminal(terminalId, cols, rows);
        });

        socket.on("kill_terminal", (data: any) => {
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
            } else {
                socket.emit("terminal_error", { terminalId, message: "Terminal not found" });
            }
        });

        socket.on("list_terminals", () => {
            if (isShuttingDown()) return;
            const list = listTerminals();
            logInfo(`[terminal] list_terminals: ${list.length} active (${list.join(", ") || "none"})`);
            // terminals_list is not in the typed protocol yet — emit untyped
            (socket as any).emit("terminals_list", { terminals: list });
        });
    }

    dispose(): void {
        killAllTerminals();
    }
}
