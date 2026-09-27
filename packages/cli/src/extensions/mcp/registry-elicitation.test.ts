import { expect, test } from "bun:test";
import { registerMcpTools } from "./registry.js";
import { registerApprovalBridge, consumePendingApprovalFromWeb } from "../remote-approval.js";
import type { RelayContext } from "../remote-types.js";
import type { McpClient } from "./types.js";

test.each([false, true])("registered MCP tool handles web forms and lifecycle cancellation (abort=%s)", async (abort) => {
  const lifetime = new AbortController();
  const calls: any[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as any;
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "server/discover") return reply({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, serverInfo: { name: "contacts", version: "1" } });
    if (body.method === "tools/list") return reply({ tools: [{ name: "contact", inputSchema: { type: "object" } }] });
    if (body.method === "tools/call") {
      calls.push(body);
      if (!body.params.inputResponses) return reply({ resultType: "input_required", requestState: "opaque", inputRequests: {
        details: { method: "elicitation/create", params: { message: "Your name?", requestedSchema: { type: "object", properties: { name: { type: "string", minLength: 2 } }, required: ["name"] } } },
      } });
      return reply({ content: [{ type: "text", text: "Saved" }] });
    }
    return new Response(null, { status: 202 });
  } });
  let clients: McpClient[] = [];
  let dispose: (() => void) | undefined;
  let tool: any;
  let prompts = 0;
  const rctx = {
    pendingApproval: null,
    isConnected: () => true,
    pi: {}, relay: {}, setRelayStatus: () => {}, disconnectedStatusText: () => "Disconnected",
    forwardEvent: (event: any) => {
      if (event.type !== "approval_pending") return;
      prompts++;
      expect(event.approval.title).toBe("MCP server: contacts");
      queueMicrotask(() => {
        if (abort) { lifetime.abort(); return; }
        consumePendingApprovalFromWeb(rctx, JSON.stringify({
          promptId: event.approval.promptId, action: "approve", edits: { name: prompts === 1 ? "A" : "Alice" },
        }));
      });
    },
  } as unknown as RelayContext;
  try {
    const registration = await registerMcpTools({ registerTool: (definition: unknown) => { tool = definition; } }, {
      mcpServers: { contacts: { url: `http://127.0.0.1:${server.port}` } },
    }, undefined, lifetime.signal);
    clients = registration.clients;
    expect(registration.errors).toEqual([]);
    // The bridge becomes available after tool registration, as during startup.
    dispose = registerApprovalBridge(rctx);
    const execution = tool.execute("call-1", {}, undefined, () => { throw new Error("Intermediate answers must not be streamed"); });
    if (abort) {
      await expect(execution).rejects.toThrow();
      expect(calls).toHaveLength(1);
      expect(rctx.pendingApproval).toBeNull();
      return;
    }
    const result = await execution;
    expect(result).toEqual({ content: [{ type: "text", text: "Saved" }] });
    expect(prompts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[1].params.inputResponses).toEqual({ details: { action: "accept", content: { name: "Alice" } } });
    expect(calls[1].params.requestState).toBe("opaque");
    expect(calls[1].id).not.toBe(calls[0].id);
    expect(rctx.pendingApproval).toBeNull();
  } finally {
    dispose?.();
    for (const client of clients) client.close();
    server.stop(true);
  }
});
