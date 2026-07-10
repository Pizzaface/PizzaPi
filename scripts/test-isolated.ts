#!/usr/bin/env bun
/**
 * Run each given test file in its own `bun test` subprocess.
 *
 * Bun loads all test files in a single worker by default, so module-level
 * singletons and `mock.module` state can leak between files. This runner
 * isolates stateful suites by spawning one process per file.
 *
 * Usage:
 *   bun scripts/test-isolated.ts packages/server/tests/harness/*.test.ts
 *   bun scripts/test-isolated.ts packages/server/tests/harness/integration.test.ts
 *
 * Exits with the first non-zero subprocess exit code.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

function collectTestFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") {
      files.push(...collectTestFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

function expandArg(arg: string): string[] {
  // If the argument exists as a file, use it directly.
  try {
    if (statSync(arg).isFile()) return [resolve(arg)];
  } catch {
    // fall through to directory behavior
  }

  // Recursively collect *.test.ts files under the directory.
  try {
    if (statSync(arg).isDirectory()) {
      return collectTestFiles(arg).sort();
    }
  } catch {
    // not a directory either
  }

  // If it looks like a glob pattern ending in .test.ts but no match, fail clearly.
  if (arg.includes("*.test.ts")) {
    throw new Error(`No files matched pattern: ${arg}`);
  }

  throw new Error(`Not a file or directory: ${arg}`);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: bun scripts/test-isolated.ts <file|dir> ...");
    process.exit(1);
  }

  const files = args.flatMap(expandArg);
  if (files.length === 0) {
    console.error("No test files found.");
    process.exit(1);
  }

  const startOverall = performance.now();
  let passed = 0;
  let failed = 0;
  let firstFailure: { file: string; code: number | null } | null = null;

  for (const file of files) {
    const label = basename(file);
    const start = performance.now();
    const result = Bun.spawnSync({
      cmd: ["bun", "test", "--max-concurrency=1", file],
      env: process.env,
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
    });
    const duration = performance.now() - start;

    if (result.exitCode === 0) {
      passed++;
      console.log(`✅ ${label} (${formatDuration(duration)})`);
    } else {
      failed++;
      console.log(`❌ ${label} (${formatDuration(duration)}) — exit ${result.exitCode ?? "signal"}`);
      if (!firstFailure) {
        firstFailure = { file: label, code: result.exitCode };
      }
    }
  }

  const totalDuration = performance.now() - startOverall;
  console.log(`\n${passed} passed, ${failed} failed (${formatDuration(totalDuration)})`);

  if (firstFailure) {
    console.error(`First failure: ${firstFailure.file}`);
    process.exit(firstFailure.code ?? 1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
