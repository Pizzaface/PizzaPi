import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createProjectTrustPromptExtension } from "./project-trust-prompt.js";

let root: string;
let cwd: string;
let agentDir: string;
const prevEnv = process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "trust-prompt-"));
    cwd = join(root, "proj");
    agentDir = join(root, "agent");
    mkdirSync(join(cwd, ".pizzapi", "skills"), { recursive: true });
    mkdirSync(agentDir);
    process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH = join(root, "usage.json");
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH;
    else process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH = prevEnv;
});

function run(restart: () => void = () => {}) {
    const emitted: any[] = [];
    let handler: any;
    const pi: any = {
        on: (name: string, fn: any) => { if (name === "session_start") handler = fn; },
        events: { emit: (name: string, data: any) => emitted.push({ name, data }) },
    };
    createProjectTrustPromptExtension(cwd, agentDir, restart)!(pi);
    handler({}, { hasUI: true }); // runner workers bind a web-approval uiContext
    return emitted;
}

describe("project trust prompt", () => {
    test("prompts for an untrusted project; Trust persists and restarts", () => {
        let restarted = 0;
        const emitted = run(() => restarted++);
        expect(emitted).toHaveLength(1);
        expect(emitted[0].name).toBe("plugin:trust_prompt");
        expect(emitted[0].data.kind).toBe("project");

        emitted[0].data.respond(true);
        expect(restarted).toBe(1);
        expect(new ProjectTrustStore(agentDir).get(cwd)).toBe(true);
    });

    test("Skip does not persist or restart", () => {
        let restarted = 0;
        run(() => restarted++)[0].data.respond(false);
        expect(restarted).toBe(0);
        expect(new ProjectTrustStore(agentDir).get(cwd)).toBeNull();
    });

    test("no prompt when a decision is already saved", () => {
        new ProjectTrustStore(agentDir).set(cwd, false);
        expect(run()).toHaveLength(0);
        expect(JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8"))).toBeTruthy();
    });

    test("no prompt without project resources", () => {
        rmSync(join(cwd, ".pizzapi"), { recursive: true });
        expect(createProjectTrustPromptExtension(cwd, agentDir)).toBeNull();
    });

    test("disabled outside runner workers", () => {
        delete process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH;
        expect(createProjectTrustPromptExtension(cwd, agentDir)).toBeNull();
    });
});
