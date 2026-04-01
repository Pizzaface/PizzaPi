import { spawn, type ChildProcess } from "node:child_process";
import { getRunnerEntryPath, MAX_RESTART_ATTEMPTS } from "./config.js";
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

  /** Spawn the runner daemon. */
  start(): void {
    this.stopping = false;
    const entry = getRunnerEntryPath();
    log.info("Starting runner daemon...");

    const env = {
      ...process.env,
      PIZZAPI_SERVER_URL: `http://localhost:${this.serverPort}`,
    };

    this.child = spawn("bun", ["run", entry, "runner"], {
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
      this.child = null;
      if (!this.stopping && this.restartCount < MAX_RESTART_ATTEMPTS) {
        this.restartCount++;
        log.warn(`Restarting runner (attempt ${this.restartCount}/${MAX_RESTART_ATTEMPTS})...`);
        this.start();
      }
    });
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
