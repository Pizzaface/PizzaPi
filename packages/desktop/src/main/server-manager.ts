import { spawn, type ChildProcess } from "node:child_process";
import {
  getServerEntryPath,
  HEALTH_CHECK_INTERVAL,
  HEALTH_CHECK_TIMEOUT,
  MAX_RESTART_ATTEMPTS,
} from "./config.js";
import log from "./logger.js";

export interface ServerManagerOptions {
  port: number;
  isDev: boolean;
}

export class ServerManager {
  private child: ChildProcess | null = null;
  private port: number;
  private isDev: boolean;
  private restartCount = 0;
  private stopping = false;

  constructor(opts: ServerManagerOptions) {
    this.port = opts.port;
    this.isDev = opts.isDev;
  }

  /** Spawn the relay server and wait for it to become healthy. */
  async start(): Promise<void> {
    this.stopping = false;
    const entry = getServerEntryPath();
    log.info(`Starting relay server on port ${this.port}...`);

    const env = {
      ...process.env,
      PORT: String(this.port),
      NODE_ENV: this.isDev ? "development" : "production",
    };

    this.child = spawn("bun", ["run", entry], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child.stdout?.on("data", (data: Buffer) => {
      log.info(`[server] ${data.toString().trim()}`);
    });

    this.child.stderr?.on("data", (data: Buffer) => {
      log.warn(`[server] ${data.toString().trim()}`);
    });

    this.child.on("exit", (code, signal) => {
      log.info(`Server exited: code=${code} signal=${signal}`);
      this.child = null;
      if (!this.stopping && this.restartCount < MAX_RESTART_ATTEMPTS) {
        this.restartCount++;
        log.warn(`Restarting server (attempt ${this.restartCount}/${MAX_RESTART_ATTEMPTS})...`);
        this.start().catch((err) => log.error("Server restart failed:", err));
      }
    });

    await this.waitForHealthy();
    this.restartCount = 0;
    log.info(`Relay server healthy on port ${this.port}`);
  }

  /** Poll /health until 200 or timeout. */
  private async waitForHealthy(): Promise<void> {
    const deadline = Date.now() + HEALTH_CHECK_TIMEOUT;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://localhost:${this.port}/health`);
        if (res.ok) return;
      } catch {
        // Server not ready yet
      }
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL));
    }
    throw new Error(`Server failed to become healthy within ${HEALTH_CHECK_TIMEOUT}ms`);
  }

  /** Gracefully stop the server. */
  stop(): void {
    this.stopping = true;
    if (this.child) {
      log.info("Stopping relay server...");
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }

  /** Force-kill if still running. */
  forceKill(): void {
    this.stopping = true;
    if (this.child) {
      this.child.kill("SIGKILL");
      this.child = null;
    }
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  getPort(): number {
    return this.port;
  }
}
