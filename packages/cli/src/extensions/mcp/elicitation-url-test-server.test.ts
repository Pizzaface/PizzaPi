import { describe, expect, test } from "bun:test";
import { createStdioMcpClient } from "./transport-stdio.js";
import { createElicitationHandler, validateElicitationUrl } from "./elicitation.js";
import type { McpElicitationHandler } from "./types.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const fixture = new URL("./elicitation-url-test-server.mjs", import.meta.url).pathname;

async function withClient(run: (client: Awaited<ReturnType<typeof createStdioMcpClient>>) => Promise<void>) {
  const client = await createStdioMcpClient({ name: "elicitation-url-test", command: process.execPath, args: [fixture] });
  try { await run(client); } finally { client.close(); }
}

describe("local URL elicitation test server", () => {
  test("consent, state-only wait, browser completion, manual retry, final result", async () => {
    await withClient(async client => {
      expect((await client.listTools()).map(t => t.name)).toEqual(["connect_account"]);
      const prompts: string[] = [];
      let link = "";
      const handler: McpElicitationHandler = async params => {
        const p = params as { mode: string; url: string; message: string };
        prompts.push(p.mode);
        link = validateElicitationUrl(p.url).url.href; // what the user would see and open
        return { action: "accept" }; // consent only; nothing fetched here
      };
      let resumes = 0;
      handler.resume = async () => {
        resumes++;
        if (resumes === 1) return "retry"; // user retried too early: server sends another state-only round
        // Simulate the user finishing the page in a browser, then retrying.
        const complete = new URL(link);
        complete.pathname = "/complete";
        expect((await fetch(complete)).ok).toBe(true);
        return "retry";
      };
      const result = await client.callTool("connect_account", {}, undefined, handler);
      expect(prompts).toEqual(["url"]); // no repeated consent
      expect(resumes).toBe(2);
      expect(result.content).toEqual([{ type: "text", text: "Account connected. Out-of-band step completed." }]);
    });
  });

  test("cancel during the wait ends the call without retrying; decline never opens", async () => {
    await withClient(async client => {
      const handler: McpElicitationHandler = async () => ({ action: "accept" });
      handler.resume = async () => "cancel";
      await expect(client.callTool("connect_account", {}, undefined, handler)).rejects.toThrow("cancelled");
      const declined = await client.callTool("connect_account", {}, undefined, async () => ({ action: "decline" }));
      expect(declined.content).toEqual([{ type: "text", text: "Elicitation decline; account not connected." }]);
    });
  });

  test("repeated URL rounds go through the Retry/Open again card via the real TUI handler", async () => {
    await withClient(async client => {
      const titles: string[] = [];
      const options: string[][] = [];
      let link = "";
      const ctx = { hasUI: true, mode: "tui", ui: {
        select: async (title: string, opts: string[]) => {
          titles.push(title); options.push(opts);
          link ||= /http:\/\/127\.0\.0\.1:\d+\/connect\?flow=[^\s]+/.exec(title)![0];
          if (options.length === 1) return "Open in browser (I opened the URL myself)";
          const complete = new URL(link); complete.pathname = "/complete";
          await fetch(complete);
          return "Retry";
        },
        input: async () => undefined,
      } } as unknown as ExtensionContext;
      const result = await client.callTool("connect_account", { repeatUrl: true }, undefined, createElicitationHandler("elicitation-url-test", ctx));
      expect(options[0]).toEqual(["Open in browser (I opened the URL myself)", "Decline", "Cancel"]);
      expect(options[1]).toEqual(["Retry", "Open again (I opened the URL myself)", "Decline", "Cancel"]);
      expect(titles[1]).toContain("already opened");
      expect(result.content).toEqual([{ type: "text", text: "Account connected. Out-of-band step completed." }]);
    });
  });

  test("headless client advertises no elicitation and the fixture refuses", async () => {
    await withClient(async client => {
      const result = await client.callTool("connect_account", {});
      expect(result.isError).toBe(true);
    });
  });

  test("fixture rejects an unknown requestState instead of creating a flow", async () => {
    const proc = Bun.spawn([process.execPath, fixture], { stdin: "pipe", stdout: "pipe" });
    try {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "connect_account", requestState: "forged", _meta: { "io.modelcontextprotocol/clientCapabilities": { elicitation: { url: {} } } } } }) + "\n");
      await proc.stdin.flush();
      const reader = proc.stdout.getReader();
      const { value } = await reader.read();
      expect(JSON.parse(new TextDecoder().decode(value)).error.message).toContain("Unknown");
    } finally {
      proc.kill();
    }
  });
});
