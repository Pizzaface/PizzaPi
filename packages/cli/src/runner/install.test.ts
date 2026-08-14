import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateRunnerServiceFiles, runInstall } from "./install.js";

describe("runner install", () => {
    test("generates macOS and Linux service files", () => {
        const mac = generateRunnerServiceFiles("darwin", "/tmp/pizzapi-home", ["/bin/pizza", "runner"], "/tmp/project", "/bun/bin:/usr/bin")[0];
        expect(mac.path).toContain("Library/LaunchAgents/com.pizzapi.runner.plist");
        expect(mac.content).toContain("ProgramArguments");
        expect(mac.content).toContain("<key>PATH</key><string>/bun/bin:/usr/bin</string>");
        expect(mac.content).toContain("<key>WorkingDirectory</key><string>/tmp/project</string>");
        expect(mac.content).toContain("<key>SuccessfulExit</key><false/>");
        expect(mac.content).not.toContain("<key>KeepAlive</key><true/>");

        const linux = generateRunnerServiceFiles("linux", "/tmp/pizzapi-home", ["/bin/pizza", "runner"], "/tmp/project")[0];
        expect(linux.path).toContain("systemd/user/pizzapi-runner.service");
        expect(linux.content).toContain("ExecStart");
        expect(linux.content).toContain("WantedBy=default.target");
        expect(linux.content).toContain("WorkingDirectory='/tmp/project'");
    });

    test("dry-run prints without writing", () => {
        const home = mkdtempSync(join(tmpdir(), "pizzapi-install-test-"));
        const result = Bun.spawnSync([process.execPath, "-e", `import { runInstall } from ${JSON.stringify(new URL("./install.ts", import.meta.url).pathname)}; process.exit(runInstall(["--dry-run"], "linux", ${JSON.stringify(home)}));`], { stdout: "pipe", stderr: "pipe" });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toContain("pizzapi-runner.service");
        expect(Bun.file(join(home, ".config/systemd/user/pizzapi-runner.service")).exists()).resolves.toBe(false);
    });
});
