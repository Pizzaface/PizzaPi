import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeExecutable(path: string, content: string) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

describe("scripts/start-redis.sh", () => {
  test("treats an existing listener on port 6379 as success", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pizzapi-start-redis-"));
    tempDirs.push(tempDir);

    const fakeBin = join(tempDir, "bin");
    mkdirSync(fakeBin, { recursive: true });

    const dockerLog = join(tempDir, "docker.log");

    makeExecutable(
      join(fakeBin, "docker"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${dockerLog}"
case "\${1:-}" in
  info)
    exit 0
    ;;
  inspect)
    exit 1
    ;;
  *)
    echo "unexpected docker command: $*" >&2
    exit 99
    ;;
esac
`,
    );

    makeExecutable(
      join(fakeBin, "lsof"),
      `#!/usr/bin/env bash
set -euo pipefail
echo 'redis-server 123 pizza 3u IPv4 0t0 TCP localhost:6379 (LISTEN)'
`,
    );

    const result = Bun.spawnSync({
      cmd: ["bash", "scripts/start-redis.sh"],
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toContain(
      "✅ Port 6379 is already in use by an existing local service.",
    );
    expect(result.stdout.toString()).toContain("Reusing redis://localhost:6379");

    const dockerCommands = readFileSync(dockerLog, "utf8");
    expect(dockerCommands).toContain("info");
    expect(dockerCommands).toContain("inspect pizzapi-redis-dev --format {{.State.Status}}");
    expect(dockerCommands).not.toContain(" run ");
    expect(dockerCommands).not.toContain(" start ");
    expect(dockerCommands).not.toContain(" exec ");
  });
});
