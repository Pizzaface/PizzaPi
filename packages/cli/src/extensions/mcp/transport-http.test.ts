import { afterEach, describe, expect, test } from "bun:test";
import { createHttpMcpClient } from "./transport-http.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("HTTP MCP protocol eras", () => {
  test("falls back when discovery receives no response", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      methods.push(body.method);
      if (body.method === "server/discover") {
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        });
      }
      return response({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {} } });
    }) as typeof fetch;
    const client = createHttpMcpClient({ name: "silent", url: "https://example.test" });
    try {
      await client.initialize();
      expect(methods).toEqual(["server/discover", "initialize", "notifications/initialized"]);
    } finally {
      client.close();
    }
  });

  test("closing during discovery does not trigger legacy fallback", async () => {
    const started = Promise.withResolvers<void>();
    const methods: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      methods.push(JSON.parse(String(init?.body)).method);
      started.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    }) as typeof fetch;
    const client = createHttpMcpClient({ name: "closed", url: "https://example.test" });
    const initialized = client.initialize();
    await started.promise;
    client.close();
    await expect(initialized).rejects.toThrow();
    expect(methods).toEqual(["server/discover"]);
  });
  test("accepts modern SSE results, encodes names, and does not advertise absent UI", async () => {
    let headers: Headers | undefined;
    let capabilities: unknown;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "server/discover") return response({ jsonrpc: "2.0", id: body.id, result: { supportedVersions: ["2026-07-28"] } });
      headers = new Headers(init?.headers);
      capabilities = body.params._meta["io.modelcontextprotocol/clientCapabilities"];
      return new Response(`data: ${JSON.stringify({jsonrpc:"2.0",method:"notifications/progress"})}\n\ndata: ${JSON.stringify({jsonrpc:"2.0", id:body.id, result:{content:[]}})}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const client = createHttpMcpClient({ name: "s", url: "https://example.test" });
    expect(await client.callTool("é\n", {})).toEqual({content:[]});
    expect(headers?.get("mcp-name")).toBe(`=?base64?${Buffer.from("é\n").toString("base64")}?=`);
    expect(capabilities).toEqual({});
    client.close();
  });

  test.each([-32022, -32021, -32020])("does not mistake modern error %s for a legacy server", async code => {
    let count = 0;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => { count++; return response({jsonrpc:"2.0",id:1,error:{code,message:"Modern error"}},400); }) as typeof fetch;
    const client = createHttpMcpClient({ name: "s", url: "https://example.test" });
    await expect(client.initialize()).rejects.toThrow("Modern error");
    expect(count).toBe(1);
    client.close();
  });

  test("rejects colliding server requests in an SSE stream", async () => {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "server/discover") return response({ jsonrpc: "2.0", id: body.id, result: { supportedVersions: ["2026-07-28"] } });
      return new Response(`data: ${JSON.stringify({jsonrpc:"2.0",id:body.id,method:"elicitation/create",params:{}})}\n\n`, {headers:{"content-type":"text/event-stream"}});
    }) as typeof fetch;
    const client = createHttpMcpClient({ name: "s", url: "https://example.test" });
    await expect(client.callTool("ask", {})).rejects.toThrow("server-initiated");
    client.close();
  });

  test("close aborts an outstanding form callback", async () => {
    const started = Promise.withResolvers<void>();
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return response({jsonrpc:"2.0",id:body.id,result: body.method === "server/discover" ? {supportedVersions:["2026-07-28"]} : {resultType:"input_required",inputRequests:{q:{method:"elicitation/create",params:{}}}}});
    }) as typeof fetch;
    const client = createHttpMcpClient({ name: "s", url: "https://example.test" });
    const call = client.callTool("ask", {}, undefined, async (_params, signal) => {
      started.resolve();
      return new Promise(resolve => signal!.addEventListener("abort", () => resolve({action:"cancel"}), {once:true}));
    });
    await started.promise;
    client.close();
    await expect(call).rejects.toThrow();
  });

  test("does not expose modern tools requiring unsupported header mirroring", async () => {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return response({jsonrpc:"2.0",id:body.id,result: body.method === "server/discover" ? {supportedVersions:["2026-07-28"]} : {tools:[{name:"ok"},{name:"routed",inputSchema:{type:"object",properties:{region:{type:"string","x-mcp-header":"Region"}}}}]}});
    }) as typeof fetch;
    const client = createHttpMcpClient({ name: "s", url: "https://example.test" });
    expect(await client.listTools()).toEqual([{name:"ok"}]);
    client.close();
  });

  test("uses modern discovery, per-request metadata/header, and MRTR ids", async () => {
    const requests: Array<{ body: any; headers: Headers }> = [];
    globalThis.fetch = (async (_url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ body, headers: new Headers(init?.headers) });
      if (body.method === "server/discover") return response({ jsonrpc: "2.0", id: body.id, result: { supportedVersions: ["2026-07-28"] } });
      if (body.method === "tools/call" && requests.filter(r => r.body.method === "tools/call").length === 1) {
        return response({ jsonrpc: "2.0", id: body.id, result: { resultType: "input_required", inputRequests: { prompt: { method: "elicitation/create", params: { message: "Raw" } } }, requestState: "opaque" } });
      }
      return response({ jsonrpc: "2.0", id: body.id, result: { content: [] } });
    }) as typeof fetch;

    const client = createHttpMcpClient({ name: "modern", url: "https://example.test/mcp" });
    await client.callTool("ask", { x: 1 }, undefined, async params => {
      expect(params).toEqual({ message: "Raw" });
      return { action: "accept", content: { value: "yes" } };
    });

    const calls = requests.filter(r => r.body.method === "tools/call");
    expect(calls.map(r => r.body.id)).toEqual([2, 3]);
    expect(calls[0].headers.get("mcp-protocol-version")).toBe("2026-07-28");
    expect(calls[0].headers.get("mcp-method")).toBe("tools/call");
    expect(calls[0].headers.get("mcp-name")).toBe("ask");
    expect(calls[0].body.params._meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({ elicitation: { form: {}, url: {} } });
    expect(calls[1].body.params.requestState).toBe("opaque");
  });

  test("falls back to the unchanged legacy initialize on unrecognized HTTP 400", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      methods.push(body.method);
      if (body.method === "server/discover") return response({ message: "legacy" }, 400);
      if (body.method === "initialize") return response({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } });
      if (!body.id) return new Response(null, { status: 202 });
      return response({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    }) as typeof fetch;

    const client = createHttpMcpClient({ name: "legacy", url: "https://example.test/mcp" });
    await client.listTools();
    expect(methods).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/list"]);
  });
});
