import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RunnerPlatform = "darwin" | "linux";
export type ServiceFile = { path: string; content: string };

const LABEL = "com.pizzapi.runner";

function xml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function shell(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Resolve the same invocation shape as the supervisor: compiled binaries need only `runner`. */
export function runnerCommand(entry = process.argv[1] ?? "", exec = process.execPath): string[] {
    const compiled = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");
    return compiled ? [exec, "runner"] : [exec, entry, "runner"];
}

export function generateRunnerServiceFiles(platform: RunnerPlatform, home = homedir(), command = runnerCommand()): ServiceFile[] {
    if (platform === "darwin") {
        const logDir = join(home, ".pizzapi", "logs");
        const args = command.map((arg) => `        <string>${xml(arg)}</string>`).join("\n");
        return [{
            path: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
            content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n    <key>Label</key><string>${LABEL}</string>\n    <key>ProgramArguments</key>\n    <array>\n${args}\n    </array>\n    <key>WorkingDirectory</key><string>${xml(home)}</string>\n    <key>RunAtLoad</key><true/>\n    <key>KeepAlive</key><true/>\n    <key>StandardOutPath</key><string>${xml(join(logDir, "runner.log"))}</string>\n    <key>StandardErrorPath</key><string>${xml(join(logDir, "runner-error.log"))}</string>\n</dict>\n</plist>\n`,
        }];
    }

    return [{
        path: join(home, ".config", "systemd", "user", "pizzapi-runner.service"),
        content: `[Unit]\nDescription=PizzaPi Runner\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${command.map(shell).join(" ")}\nRestart=on-failure\nRestartSec=5\nWorkingDirectory=${shell(home)}\n\n[Install]\nWantedBy=default.target\n`,
    }];
}

export function runInstall(args: string[], platform: NodeJS.Platform = process.platform, home = homedir()): number {
    if (platform !== "darwin" && platform !== "linux") {
        console.error("runner install supports macOS and Linux only");
        return 1;
    }
    const dryRun = args.includes("--dry-run");
    const activate = args.includes("--activate");
    const files = generateRunnerServiceFiles(platform, home);

    for (const file of files) {
        if (dryRun) {
            console.log(`--- ${file.path} ---\n${file.content}`);
        } else {
            mkdirSync(dirname(file.path), { recursive: true });
            writeFileSync(file.path, file.content, { mode: 0o644 });
            if (platform === "darwin") mkdirSync(join(home, ".pizzapi", "logs"), { recursive: true });
            console.log(`Wrote ${file.path}`);
        }
    }
    if (activate && !dryRun) {
        if (platform === "darwin") execFileSync("launchctl", ["load", "-w", files[0].path], { stdio: "inherit" });
        else {
            execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
            execFileSync("systemctl", ["--user", "enable", "--now", "pizzapi-runner.service"], { stdio: "inherit" });
        }
    }
    return 0;
}
