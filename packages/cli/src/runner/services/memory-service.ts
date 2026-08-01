import type { Socket } from "socket.io-client";
import type { ServiceHandler, ServiceInitOptions, ServiceEnvelope } from "../service-handler.js";
import { isCwdAllowed } from "../workspace.js";
import {
  listFiles,
  readMemoryFile,
  writeMemoryFile,
  memoryDir,
  readIndexTruncated,
} from "../../extensions/memory/storage.js";

/**
 * Web UI backend for per-project memory. Lets the Memory panel browse and edit
 * the machine-local memory store the agent writes to via the memory_* tools.
 *
 * The project directory is resolved server-side from the session (never trusted
 * from the client) and validated against workspace roots, so the panel can only
 * touch memory for directories the runner already allows.
 */
export class MemoryService implements ServiceHandler {
  readonly id = "memory";

  private socket: Socket | null = null;
  private _onServiceMessage: ((envelope: ServiceEnvelope) => void) | null = null;

  constructor(private getSessionCwd: (sessionId: string) => string | null) {}

  init(socket: Socket, { isShuttingDown }: ServiceInitOptions): void {
    this.socket = socket;
    this._onServiceMessage = (envelope: ServiceEnvelope) => {
      if (isShuttingDown()) return;
      if (envelope.serviceId !== "memory") return;
      switch (envelope.type) {
        case "memory_list":
          this.handle(envelope, (cwd) => ({
            dir: memoryDir(cwd),
            files: listFiles(cwd),
            index: readIndexTruncated(cwd).text,
          }));
          break;
        case "memory_read":
          this.handle(envelope, (cwd) => {
            const file = (envelope.payload as { file?: string })?.file;
            if (!file) throw new Error("Missing file");
            return { file, content: readMemoryFile(file, cwd) };
          });
          break;
        case "memory_write":
          this.handle(envelope, (cwd) => {
            const p = envelope.payload as { file?: string; content?: string };
            if (!p?.file) throw new Error("Missing file");
            writeMemoryFile(p.file, p.content ?? "", cwd);
            return { file: p.file, saved: true };
          });
          break;
      }
    };
    (socket as any).on("service_message", this._onServiceMessage);
  }

  dispose(): void {
    if (this.socket && this._onServiceMessage) {
      (this.socket as any).off("service_message", this._onServiceMessage);
    }
    this.socket = null;
    this._onServiceMessage = null;
  }

  private resolveCwd(envelope: ServiceEnvelope): string | null {
    const sessionId =
      (typeof envelope.sessionId === "string" && envelope.sessionId) ||
      (envelope.payload as { sessionId?: string })?.sessionId ||
      null;
    return sessionId ? this.getSessionCwd(sessionId) : null;
  }

  private handle(envelope: ServiceEnvelope, fn: (cwd: string) => unknown): void {
    const cwd = this.resolveCwd(envelope);
    if (!cwd || !isCwdAllowed(cwd)) {
      this.emit("memory_error", { error: "No accessible project for this session" }, envelope.requestId);
      return;
    }
    try {
      this.emit(`${envelope.type}_result`, fn(cwd), envelope.requestId);
    } catch (err) {
      this.emit("memory_error", { error: err instanceof Error ? err.message : String(err) }, envelope.requestId);
    }
  }

  private emit(type: string, payload: unknown, requestId?: string): void {
    if (!this.socket) return;
    (this.socket as any).emit("service_message", {
      serviceId: "memory",
      type,
      ...(requestId ? { requestId } : {}),
      payload,
    } satisfies ServiceEnvelope);
  }
}
