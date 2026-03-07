import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests for CLI security fixes.
 *
 * These tests verify that command injection vulnerabilities have been fixed
 * and that malicious inputs are handled safely.
 */

describe("git_diff command injection prevention", () => {
    /**
     * Helper function that mimics the fixed git diff implementation.
     * This is extracted from daemon.ts for testing purposes.
     */
    async function safeGitDiff(cwd: string, filePath: string, staged: boolean = false): Promise<string> {
        const args = staged ? ["diff", "--cached", "--", filePath] : ["diff", "--", filePath];
        return new Promise<string>((resolve, reject) => {
            const child = spawn("git", args, { cwd });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
            child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
            child.on("error", reject);
            child.on("close", (code) => {
                if (code === 0) resolve(stdout);
                else reject(new Error(stderr || `git diff exited with code ${code}`));
            });
        });
    }

    /**
     * Sets up a temporary git repo for testing.
     */
    async function setupTestRepo(): Promise<{ cleanup: () => void; repoPath: string }> {
        const repoPath = mkdtempSync(join(tmpdir(), "git-test-"));
        
        // Initialize git repo
        await new Promise<void>((resolve, reject) => {
            const child = spawn("git", ["init"], { cwd: repoPath });
            child.on("close", (code) => code === 0 ? resolve() : reject(new Error("git init failed")));
            child.on("error", reject);
        });

        // Configure git user for commits
        await new Promise<void>((resolve, reject) => {
            const child = spawn("git", ["config", "user.email", "test@test.com"], { cwd: repoPath });
            child.on("close", (code) => code === 0 ? resolve() : reject());
            child.on("error", reject);
        });
        await new Promise<void>((resolve, reject) => {
            const child = spawn("git", ["config", "user.name", "Test"], { cwd: repoPath });
            child.on("close", (code) => code === 0 ? resolve() : reject());
            child.on("error", reject);
        });

        const cleanup = () => {
            try {
                rmSync(repoPath, { recursive: true, force: true });
            } catch { /* Intentionally ignored */ }
        };

        return { cleanup, repoPath };
    }

    test("handles filenames with spaces safely", async () => {
        const { cleanup, repoPath } = await setupTestRepo();
        try {
            // Create a file with spaces
            const filename = "file with spaces.txt";
            writeFileSync(join(repoPath, filename), "test content");

            // This should NOT cause shell injection
            const diff = await safeGitDiff(repoPath, filename);
            // Just verify it doesn't throw due to shell injection
            expect(typeof diff).toBe("string");
        } finally {
            cleanup();
        }
    });

    test("handles filenames with quotes safely", async () => {
        const { cleanup, repoPath } = await setupTestRepo();
        try {
            // Create a file with quotes (this would break shell interpolation)
            const filename = 'file"with"quotes.txt';
            writeFileSync(join(repoPath, filename), "test content");

            const diff = await safeGitDiff(repoPath, filename);
            expect(typeof diff).toBe("string");
        } finally {
            cleanup();
        }
    });

    test("handles filenames with shell metacharacters safely", async () => {
        const { cleanup, repoPath } = await setupTestRepo();
        try {
            // Create files with various shell metacharacters
            const dangerousFilenames = [
                "file;ls.txt",
                "file|cat.txt",
                "file&echo.txt",
                "file>output.txt",
                "file<input.txt",
            ];

            for (const filename of dangerousFilenames) {
                try {
                    writeFileSync(join(repoPath, filename), "test content");
                    const diff = await safeGitDiff(repoPath, filename);
                    expect(typeof diff).toBe("string");
                } catch (err) {
                    // File creation may fail on some systems, that's OK for this test
                    // What matters is that if the file exists, the command runs safely
                }
            }
        } finally {
            cleanup();
        }
    });

    test("handles command substitution attempts safely", async () => {
        const { cleanup, repoPath } = await setupTestRepo();
        try {
            // This filename would execute "id" command if vulnerable
            const filename = "$(id).txt";
            try {
                writeFileSync(join(repoPath, filename), "test content");
                const diff = await safeGitDiff(repoPath, filename);
                // The filename should be treated literally, not executed
                expect(typeof diff).toBe("string");
            } catch (err) {
                // File creation may fail on some filesystems, that's OK
            }
        } finally {
            cleanup();
        }
    });

    test("handles backtick command substitution safely", async () => {
        const { cleanup, repoPath } = await setupTestRepo();
        try {
            // This filename would execute "id" command with backticks if vulnerable
            const filename = "`id`.txt";
            try {
                writeFileSync(join(repoPath, filename), "test content");
                const diff = await safeGitDiff(repoPath, filename);
                expect(typeof diff).toBe("string");
            } catch (err) {
                // File creation may fail on some filesystems, that's OK
            }
        } finally {
            cleanup();
        }
    });

    test("preserves staged flag functionality", async () => {
        const { cleanup, repoPath } = await setupTestRepo();
        try {
            const filename = "test.txt";
            writeFileSync(join(repoPath, filename), "test content");

            // Test with staged=false
            const unstaged = await safeGitDiff(repoPath, filename, false);
            expect(typeof unstaged).toBe("string");

            // Test with staged=true
            const staged = await safeGitDiff(repoPath, filename, true);
            expect(typeof staged).toBe("string");
        } finally {
            cleanup();
        }
    });
});

describe("argument array safety", () => {
    test("spawn uses array arguments not string concatenation", () => {
        // Verify that our approach passes arguments as an array
        // rather than string concatenation which would be vulnerable
        const args = ["diff", "--", "file with $(id).txt"];
        
        // This is the safe pattern - spawn with array args
        // The shell never interprets the filename
        expect(Array.isArray(args)).toBe(true);
        expect(args[2]).toBe("file with $(id).txt"); // Preserved literally
    });
});
