import { spawn, type ChildProcess } from "node:child_process";
import { getRunnerEntryPath, getBunPath, MAX_RESTART_ATTEMPTS, HEALTH_CHECK_TIMEOUT } from "./config.js";
import log from "./logger.js";

export interface RunnerManagerOptions {
  serverPort: number;
  isDev: boolean;
}

export class RunnerManager {
  private child: ChildProcess | null = null;
  private serverPort: number;
  private isDev: boolean;
  private restartCount = 0;
  private stopping = false;

  constructor(opts: RunnerManagerOptions) {
    this.serverPort = opts.serverPort;
    this.isDev = opts.isDev;
  }

  /**
   * Spawn the runner daemon and wait for it to register with the server.
   * Polls /api/runners until the runner appears, or times out.
   */
  async start(): Promise<void> {
    this.stopping = false;
    const entry = getRunnerEntryPath();
    log.info("Starting runner daemon...");

    let earlyExit = false;

    const env = {
      ...process.env,
      PIZZAPI_SERVER_URL: `http://localhost:${this.serverPort}`,
    };

    const bunPath = getBunPath();
    this.child = spawn(bunPath, ["run", entry, "runner"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child.stdout?.on("data", (data: Buffer) => {
      log.info(`[runner] ${data.toString().trim()}`);
    });

    this.child.stderr?.on("data", (data: Buffer) => {
      log.warn(`[runner] ${data.toString().trim()}`);
    });

    this.child.on("exit", (code, signal) => {
      log.info(`Runner exited: code=${code} signal=${signal}`);
      earlyExit = true;
      this.child = null;
      if (!this.stopping && this.restartCount < MAX_RESTART_ATTEMPTS) {
        this.restartCount++;
        log.warn(`Restarting runner (attempt ${this.restartCount}/${MAX_RESTART_ATTEMPTS})...`);
        this.start().catch((err) => log.error("Runner restart failed:", err));
      }
    });

    // Wait for the runner to register with the server (poll /api/runners)
    await this.waitForReady(() => earlyExit);
    log.info("Runner daemon is ready");
  }

  /**
   * Poll the server's /api/runners endpoint until at least one runner
   * appears, indicating the daemon has connected. Times out after
   * HEALTH_CHECK_TIMEOUT ms.
   */
  private async waitForReady(hasExited: () => boolean): Promise<void> {
    const deadline = Date.now() + HEALTH_CHECK_TIMEOUT;
    while (Date.now() < deadline) {
      if (hasExited()) {
        throw new Error("Runner process exited before becoming ready");
      }
      try {
        const res = await fetch(`http://localhost:${this.serverPort}/api/runners`, {
          headers: { "Content-Type": "application/json" },
        });
        if (res.ok) {
          const body = await res.json() as any;
          if (Array.isArray(body?.runners) && body.runners.length > 0) {
            return;
          }
        }
      } catch {
        // Server not ready or runner not registered yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    // Don't throw — runner may still be starting up and will register soon.
    // Just warn so the caller can mark it as running optimistically.
    log.warn("Runner did not register within timeout, continuing...");
  }

  /** Gracefully stop the runner. */
  stop(): void {
    this.stopping = true;
    if (this.child) {
      log.info("Stopping runner daemon...");
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
}
