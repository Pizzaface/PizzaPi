import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
    parseAgentFrontmatterFromString,
    scanAgentsDir,
    scanGlobalAgents,
    readAgentContent,
    writeAgent,
    deleteAgent,
    findAgentDir,
} from "./agents.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
    const dir = join(tmpdir(), `pizzapi-agent-test-${randomBytes(8).toString("hex")}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function writeAgentFile(agentsDir: string, name: string, content: string): string {
    mkdirSync(agentsDir, { recursive: true });
    const filePath = join(agentsDir, `${name}.md`);
    writeFileSync(filePath, content, "utf-8");
    return filePath;
}

const AGENT_WITH_DESCRIPTION = `---
description: A helpful agent for testing.
---

# My Agent

Do the thing.
`;

const AGENT_QUOTED_DESCRIPTION = `---
description: "A quoted description"
---

# Quoted Agent
`;

const AGENT_NO_FRONTMATTER = `# Just Markdown

No frontmatter here.
`;

// ── parseAgentFrontmatterFromString ───────────────────────────────────────────

describe("parseAgentFrontmatterFromString", () => {
    test("parses a plain description", () => {
        const result = parseAgentFrontmatterFromString(AGENT_WITH_DESCRIPTION);
        expect(result.description).toBe("A helpful agent for testing.");
    });

    test("strips double quotes from description", () => {
        const result = parseAgentFrontmatterFromString(AGENT_QUOTED_DESCRIPTION);
        expect(result.description).toBe("A quoted description");
    });

    test("returns empty string when there is no frontmatter", () => {
        const result = parseAgentFrontmatterFromString(AGENT_NO_FRONTMATTER);
        expect(result.description).toBe("");
    });

    test("returns empty string for empty content", () => {
        const result = parseAgentFrontmatterFromString("");
        expect(result.description).toBe("");
    });
});

// ── scanAgentsDir ─────────────────────────────────────────────────────────────

describe("scanAgentsDir", () => {
    let dir: string;

    beforeEach(() => { dir = makeTmpDir(); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    test("returns empty array for non-existent directory", () => {
        expect(scanAgentsDir(join(dir, "nope"))).toEqual([]);
    });

    test("returns empty array for empty directory", () => {
        expect(scanAgentsDir(dir)).toEqual([]);
    });

    test("discovers .md files as agents", () => {
        writeAgentFile(dir, "my-agent", AGENT_WITH_DESCRIPTION);
        const result = scanAgentsDir(dir);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("my-agent");
        expect(result[0].description).toBe("A helpful agent for testing.");
        expect(result[0].filePath).toBe(join(dir, "my-agent.md"));
    });

    test("discovers agents with non-lowercase names", () => {
        writeAgentFile(dir, "Foo", AGENT_WITH_DESCRIPTION);
        writeAgentFile(dir, "foo_bar", AGENT_WITH_DESCRIPTION);
        writeAgentFile(dir, "foo.bar", AGENT_WITH_DESCRIPTION);
        const result = scanAgentsDir(dir);
        expect(result).toHaveLength(3);
        const names = result.map((a) => a.name).sort();
        expect(names).toEqual(["Foo", "foo.bar", "foo_bar"]);
    });

    test("ignores hidden files", () => {
        writeAgentFile(dir, ".hidden", AGENT_WITH_DESCRIPTION);
        expect(scanAgentsDir(dir)).toEqual([]);
    });

    test("ignores non-.md files", () => {
        writeFileSync(join(dir, "notes.txt"), "not an agent", "utf-8");
        expect(scanAgentsDir(dir)).toEqual([]);
    });

    test("skips broken symlinks without crashing other agents", () => {
        writeAgentFile(dir, "good-agent", AGENT_WITH_DESCRIPTION);
        const brokenLink = join(dir, "broken.md");
        try {
            require("node:fs").symlinkSync("/nonexistent/path/file.md", brokenLink);
        } catch {
            // Skip if symlinks not supported
            return;
        }
        const result = scanAgentsDir(dir);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("good-agent");
    });

    test("handles binary content in .md files gracefully", () => {
        writeAgentFile(dir, "valid", AGENT_WITH_DESCRIPTION);
        // Write binary garbage as a .md file
        const binaryPath = join(dir, "binary.md");
        require("node:fs").writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]));
        const result = scanAgentsDir(dir);
        expect(result).toHaveLength(2);
        // Both should load — binary one just won't have a description
        const valid = result.find(a => a.name === "valid");
        expect(valid?.description).toBe("A helpful agent for testing.");
    });

    test("handles malformed frontmatter without crashing", () => {
        writeAgentFile(dir, "good", AGENT_WITH_DESCRIPTION);
        writeAgentFile(dir, "bad-frontmatter", "---\nthis is not: [valid: yaml: {{{\n---\n# Bad");
        const result = scanAgentsDir(dir);
        expect(result).toHaveLength(2);
        const good = result.find(a => a.name === "good");
        expect(good?.description).toBe("A helpful agent for testing.");
    });
});

// ── findAgentDir ──────────────────────────────────────────────────────────────

describe("findAgentDir", () => {
    let primaryDir: string;
    let secondaryDir: string;

    beforeEach(() => {
        primaryDir = makeTmpDir();
        secondaryDir = makeTmpDir();
    });

    afterEach(() => {
        rmSync(primaryDir, { recursive: true, force: true });
        rmSync(secondaryDir, { recursive: true, force: true });
    });

    test("returns null for non-existent agent", () => {
        expect(findAgentDir("ghost", [primaryDir, secondaryDir])).toBeNull();
    });

    test("finds agent in primary directory", () => {
        writeAgentFile(primaryDir, "test-agent", AGENT_WITH_DESCRIPTION);
        expect(findAgentDir("test-agent", [primaryDir, secondaryDir])).toBe(primaryDir);
    });

    test("finds agent in secondary directory", () => {
        writeAgentFile(secondaryDir, "claude-agent", AGENT_WITH_DESCRIPTION);
        expect(findAgentDir("claude-agent", [primaryDir, secondaryDir])).toBe(secondaryDir);
    });

    test("prefers primary over secondary when both exist", () => {
        writeAgentFile(primaryDir, "both", AGENT_WITH_DESCRIPTION);
        writeAgentFile(secondaryDir, "both", AGENT_WITH_DESCRIPTION);
        expect(findAgentDir("both", [primaryDir, secondaryDir])).toBe(primaryDir);
    });
});

// ── writeAgent (source directory preservation) ────────────────────────────────

describe("writeAgent", () => {
    let dir: string;

    beforeEach(() => { dir = makeTmpDir(); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    test("creates a new agent file", async () => {
        await writeAgent("new-agent", AGENT_WITH_DESCRIPTION, dir);
        const filePath = join(dir, "new-agent.md");
        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath, "utf-8")).toBe(AGENT_WITH_DESCRIPTION);
    });

    test("overwrites existing agent content", async () => {
        await writeAgent("update-me", "old content", dir);
        await writeAgent("update-me", "new content", dir);
        expect(readFileSync(join(dir, "update-me.md"), "utf-8")).toBe("new content");
    });

    test("preserves source directory for existing agents", async () => {
        // Simulate two search directories (like ~/.pizzapi/agents and ~/.claude/agents)
        const primaryDir = makeTmpDir();
        const secondaryDir = makeTmpDir();
        try {
            writeAgentFile(secondaryDir, "claude-only", "original content");

            // findAgentDir should find it in the secondary directory
            const foundDir = findAgentDir("claude-only", [primaryDir, secondaryDir]);
            expect(foundDir).toBe(secondaryDir);

            // writeAgent with the found dir should update in place
            await writeAgent("claude-only", "updated content", foundDir!);

            const secondaryPath = join(secondaryDir, "claude-only.md");
            expect(readFileSync(secondaryPath, "utf-8")).toBe("updated content");

            // Should NOT have created a shadow copy in the primary dir
            const primaryPath = join(primaryDir, "claude-only.md");
            expect(existsSync(primaryPath)).toBe(false);
        } finally {
            rmSync(primaryDir, { recursive: true, force: true });
            rmSync(secondaryDir, { recursive: true, force: true });
        }
    });
});

// ── readAgentContent ──────────────────────────────────────────────────────────

describe("readAgentContent", () => {
    let dir: string;

    beforeEach(() => { dir = makeTmpDir(); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    test("reads agent content", () => {
        writeAgentFile(dir, "test", AGENT_WITH_DESCRIPTION);
        const content = readAgentContent("test", dir);
        expect(content).toBe(AGENT_WITH_DESCRIPTION);
    });

    test("returns null for non-existent agent", () => {
        expect(readAgentContent("ghost", dir)).toBeNull();
    });
});

// ── deleteAgent ───────────────────────────────────────────────────────────────

describe("deleteAgent", () => {
    let dir: string;

    beforeEach(() => { dir = makeTmpDir(); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    test("deletes an agent", () => {
        writeAgentFile(dir, "doomed", AGENT_WITH_DESCRIPTION);
        expect(deleteAgent("doomed", dir)).toBe(true);
        expect(existsSync(join(dir, "doomed.md"))).toBe(false);
    });

    test("returns false for non-existent agent", () => {
        expect(deleteAgent("ghost", dir)).toBe(false);
    });
});

// ── Agent lifecycle ───────────────────────────────────────────────────────────

describe("agent lifecycle", () => {
    let dir: string;

    beforeEach(() => { dir = makeTmpDir(); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    test("full CRUD cycle", async () => {
        expect(scanAgentsDir(dir)).toEqual([]);

        await writeAgent("test-agent", AGENT_WITH_DESCRIPTION, dir);
        const scanned = scanAgentsDir(dir);
        expect(scanned).toHaveLength(1);
        expect(scanned[0].name).toBe("test-agent");

        const content = readAgentContent("test-agent", dir);
        expect(content).toBe(AGENT_WITH_DESCRIPTION);

        const updated = AGENT_WITH_DESCRIPTION.replace("A helpful agent for testing.", "Updated.");
        await writeAgent("test-agent", updated, dir);
        const rescanned = scanAgentsDir(dir);
        expect(rescanned[0].description).toBe("Updated.");

        expect(deleteAgent("test-agent", dir)).toBe(true);
        expect(scanAgentsDir(dir)).toEqual([]);
    });
});

// ── Name validation regex (mirrors daemon.ts update_agent) ────────────────────

describe("agent name validation", () => {
    const updateRegex = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

    test("accepts lowercase-hyphen names", () => {
        expect(updateRegex.test("my-agent")).toBe(true);
    });

    test("accepts names with underscores", () => {
        expect(updateRegex.test("foo_bar")).toBe(true);
    });

    test("accepts names with dots", () => {
        expect(updateRegex.test("foo.bar")).toBe(true);
    });

    test("accepts uppercase names", () => {
        expect(updateRegex.test("Foo")).toBe(true);
        expect(updateRegex.test("FooBar")).toBe(true);
    });

    test("accepts single character names", () => {
        expect(updateRegex.test("a")).toBe(true);
        expect(updateRegex.test("1")).toBe(true);
    });

    test("rejects names starting with special chars", () => {
        expect(updateRegex.test("-agent")).toBe(false);
        expect(updateRegex.test(".agent")).toBe(false);
        expect(updateRegex.test("_agent")).toBe(false);
    });

    test("rejects names with path separators", () => {
        expect(updateRegex.test("../evil")).toBe(false);
        expect(updateRegex.test("foo/bar")).toBe(false);
    });

    test("rejects empty names", () => {
        expect(updateRegex.test("")).toBe(false);
    });

    test("rejects names with spaces", () => {
        expect(updateRegex.test("foo bar")).toBe(false);
    });
});
