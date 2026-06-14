import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    makeExecutable(
      join(fakeBin, "redis-cli"),
      `#!/usr/bin/env bash
set -euo pipefail
echo PONG
`,
    );

    const result = Bun.spawnSync({
      cmd: ["/bin/bash", "scripts/start-redis.sh"],
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
      "✅ Redis is already running on port 6379.",
    );
    expect(result.stdout.toString()).toContain("Reusing redis://localhost:6379");

    expect(existsSync(dockerLog)).toBe(false);
  });

  test("reuses an existing listener before requiring Docker", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pizzapi-start-redis-no-docker-"));
    tempDirs.push(tempDir);

    const fakeBin = join(tempDir, "bin");
    mkdirSync(fakeBin, { recursive: true });

    makeExecutable(
      join(fakeBin, "lsof"),
      `#!/usr/bin/env bash
set -euo pipefail
echo 'redis-server 123 pizza 3u IPv4 0t0 TCP localhost:6379 (LISTEN)'
`,
    );

    makeExecutable(
      join(fakeBin, "redis-cli"),
      `#!/usr/bin/env bash
set -euo pipefail
echo PONG
`,
    );

    const result = Bun.spawnSync({
      cmd: ["/bin/bash", "scripts/start-redis.sh"],
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toContain(
      "✅ Redis is already running on port 6379.",
    );
    expect(result.stdout.toString()).toContain("Reusing redis://localhost:6379");
  });

  test("fails clearly when port 6379 is used by a non-Redis listener", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pizzapi-start-redis-non-redis-"));
    tempDirs.push(tempDir);

    const fakeBin = join(tempDir, "bin");
    mkdirSync(fakeBin, { recursive: true });

    makeExecutable(
      join(fakeBin, "lsof"),
      `#!/usr/bin/env bash
set -euo pipefail
echo 'python 123 pizza 3u IPv4 0t0 TCP localhost:6379 (LISTEN)'
`,
    );

    makeExecutable(
      join(fakeBin, "redis-cli"),
      `#!/usr/bin/env bash
set -euo pipefail
exit 1
`,
    );

    const result = Bun.spawnSync({
      cmd: ["/bin/bash", "scripts/start-redis.sh"],
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toContain(
      "❌ Port 6379 is in use, but it does not respond to Redis PING.",
    );
    expect(result.stdout.toString()).not.toContain("Reusing redis://localhost:6379");
  });

  test("falls back to Docker when the Redis port is free", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pizzapi-start-redis-free-port-"));
    tempDirs.push(tempDir);

    const fakeBin = join(tempDir, "bin");
    mkdirSync(fakeBin, { recursive: true });

    const dockerLog = join(tempDir, "docker.log");

    makeExecutable(
      join(fakeBin, "lsof"),
      `#!/usr/bin/env bash
set -euo pipefail
exit 1
`,
    );

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
  run)
    echo fake-container-id
    exit 0
    ;;
  exec)
    echo PONG
    exit 0
    ;;
  *)
    echo "unexpected docker command: $*" >&2
    exit 99
    ;;
esac
`,
    );

    const result = Bun.spawnSync({
      cmd: ["/bin/bash", "scripts/start-redis.sh"],
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toContain("🚀 Starting Redis container");
    expect(result.stdout.toString()).toContain("✅ Redis is ready!");

    const dockerCommands = readFileSync(dockerLog, "utf8");
    expect(dockerCommands).toContain("info");
    expect(dockerCommands).toContain("run -d --name pizzapi-redis-dev");
    expect(dockerCommands).toContain("exec pizzapi-redis-dev redis-cli ping");
  });
});
