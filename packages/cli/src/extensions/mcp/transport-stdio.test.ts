/**
 * Stdio transport recovery: when the MCP server process dies, the client must
 * reject in-flight requests fast (not pend forever on a dead pipe) and
 * transparently respawn + re-handshake on the next call.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStdioMcpClient } from "./transport-stdio.js";

// Fake stdio MCP server: answers initialize/tools/list/tools/call; the
// "die" tool makes it exit without responding, simulating a server crash.
const FAKE_SERVER = `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;
  let result;
  if (msg.method === "initialize") {
    result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0.0" } };
  } else if (msg.method === "tools/list") {
    result = { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] };
  } else if (msg.method === "tools/call") {
    if (msg.params?.name === "die") process.exit(0);
    result = { content: [{ type: "text", text: "pong" }] };
  } else {
    result = {};
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
`;

function makeFakeServerPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "mcp-stdio-test-"));
    const p = join(dir, "fake-server.cjs");
    writeFileSync(p, FAKE_SERVER);
    return p;
}

describe("stdio transport recovery", () => {
    test("rejects in-flight request when server dies, respawns on next call", async () => {
        const client = await createStdioMcpClient({
            name: "fake",
            command: process.execPath,
            args: [makeFakeServerPath()],
        });

        // Healthy handshake + call.
        const tools = await client.listTools();
        expect(tools.map((t: any) => t.name)).toContain("ping");

        // "die" exits the server without responding — the in-flight request
        // must reject with the exit error instead of hanging forever.
        expect(client.callTool("die", {})).rejects.toThrow("MCP stdio server exited");

        // Next call must respawn a fresh server and succeed.
        const result = await client.callTool("ping", {});
        const text = (result as any)?.content?.[0]?.text;
        expect(text).toBe("pong");

        client.close();
    });
});
