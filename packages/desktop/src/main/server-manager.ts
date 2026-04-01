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

    // Check if port is available before spawning
    const portFree = await this.isPortFree(this.port);
    if (!portFree) {
      throw new Error(`Port ${this.port} is already in use. Stop the existing server or use a different port.`);
    }

    const entry = getServerEntryPath();
    log.info(`Starting relay server on port ${this.port}...`);

    const env = {
      ...process.env,
      PORT: String(this.port),
      NODE_ENV: this.isDev ? "development" : "production",
    };

    // Track if the child exits early (before health check passes)
    let earlyExit = false;
    let earlyExitCode: number | null = null;

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
      earlyExit = true;
      earlyExitCode = code;
      this.child = null;
      if (!this.stopping && this.restartCount < MAX_RESTART_ATTEMPTS) {
        this.restartCount++;
        log.warn(`Restarting server (attempt ${this.restartCount}/${MAX_RESTART_ATTEMPTS})...`);
        this.start().catch((err) => log.error("Server restart failed:", err));
      }
    });

    await this.waitForHealthy(() => earlyExit);
    this.restartCount = 0;
    log.info(`Relay server healthy on port ${this.port}`);
  }

  /** Check if a port is free. */
  private async isPortFree(port: number): Promise<boolean> {
    const net = await import("node:net");
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
  }

  /** Poll /health until 200 or timeout, aborting if the child exits early. */
  private async waitForHealthy(hasExited: () => boolean): Promise<void> {
    const deadline = Date.now() + HEALTH_CHECK_TIMEOUT;
    while (Date.now() < deadline) {
      if (hasExited()) {
        throw new Error("Server process exited before becoming healthy");
      }
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
