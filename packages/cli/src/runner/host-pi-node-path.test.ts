import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { hostPiNodePath } from "./host-pi-node-path.js";

describe("hostPiNodePath", () => {
    test("prepends the host pi node_modules once, keeping existing entries", () => {
        const first = hostPiNodePath("/x/node_modules")!;
        const [hostDir, rest] = first.split(delimiter);
        expect(hostDir.endsWith("node_modules")).toBe(true);
        expect(rest).toBe("/x/node_modules");
        expect(hostPiNodePath(first)).toBe(first);
    });

    test("a pi package with no node_modules resolves the host pi, not a Bun auto-install", () => {
        const pkg = mkdtempSync(join(tmpdir(), "pi-pkg-"));
        writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "x", peerDependencies: { "@earendil-works/pi-coding-agent": "*" } }));
        writeFileSync(join(pkg, "probe.ts"), 'console.log(import.meta.resolve("@earendil-works/pi-coding-agent"));');
        const out = Bun.spawnSync([process.execPath, "probe.ts"], {
            cwd: pkg,
            env: { ...process.env, NODE_PATH: hostPiNodePath(undefined) },
        });
        const resolved = realpathSync(new URL(out.stdout.toString().trim()).pathname);
        const host = realpathSync(new URL(import.meta.resolve("@earendil-works/pi-coding-agent")).pathname);
        expect(resolved).toBe(host);
    });
});
