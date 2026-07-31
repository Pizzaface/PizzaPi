// Session transcript analysis socket.io handler, split out of daemon.ts's runDaemon().
import type { Socket } from "socket.io-client";
import { join } from "node:path";
import { findSessionPathById } from "../session-list-cache.js";
import type { RunnerSession } from "../session-spawner.js";
import type { SessionCloseMetadata } from "../session-close-metadata.js";

export function registerSessionAnalysisHandlers(
    socket: Socket,
    isShuttingDown: () => boolean,
    runningSessions: Map<string, RunnerSession>,
    sessionCloseMetadata: Map<string, SessionCloseMetadata>,
    resolveConfiguredAgentDir: (cwd?: string) => string,
    getContextWindowsForAnalysis: (cwd?: string) => Promise<Map<string, number>>,
): void {
    socket.on("analyze_session", async (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data.requestId ?? "";
        try {
            const sessionId = data.sessionId;
            if (!sessionId || typeof sessionId !== "string") {
                socket.emit("analyze_session_error", {
                    requestId,
                    error: "Missing sessionId parameter",
                });
                return;
            }
            const sessionMetadata = sessionCloseMetadata.get(sessionId);
            const sessionsRootDir = join(resolveConfiguredAgentDir(sessionMetadata?.cwd), "sessions");
            const sessionFile = runningSessions.get(sessionId)?.sessionFile
                ?? sessionMetadata?.sessionFile
                ?? await findSessionPathById(sessionsRootDir, sessionId);
            if (!sessionFile) {
                socket.emit("analyze_session_error", {
                    requestId,
                    error: "Session file not found for " + sessionId,
                });
                return;
            }
            const MAX_ANALYSIS_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
            const transcriptFile = Bun.file(sessionFile);
            if (!await transcriptFile.exists()) {
                socket.emit("analyze_session_error", {
                    requestId,
                    error: "Session file does not exist: " + sessionFile,
                });
                return;
            }
            if (transcriptFile.size > MAX_ANALYSIS_FILE_SIZE) {
                socket.emit("analyze_session_error", {
                    requestId,
                    error: `Session file too large for analysis (${Math.round(transcriptFile.size / 1024 / 1024)} MB, max ${MAX_ANALYSIS_FILE_SIZE / 1024 / 1024} MB)`,
                });
                return;
            }
            const { parseJsonlEntries } = await import("../../session-analysis/parser.js");
            const { reconstructContext } = await import("../../session-analysis/analyzer.js");
            const content = await transcriptFile.text();
            const { entries } = parseJsonlEntries(content);
            const leafId = entries.findLast((e: any) => e.id)?.id ?? "root";
            const analysis = reconstructContext(
                entries,
                leafId,
                await getContextWindowsForAnalysis(sessionMetadata?.cwd),
            );
            socket.emit("analyze_session_data", { requestId, data: analysis });
        } catch (e: any) {
            socket.emit("analyze_session_error", {
                requestId,
                error: e.message ?? "Unknown error",
            });
        }
    });
}
