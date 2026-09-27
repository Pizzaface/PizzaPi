import { expect, test } from "bun:test";
import { createStdioMcpClient } from "./transport-stdio.js";

const script = `
const requests = [];
let rejected = false;
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.error) { rejected = m.error.code === -32601; return; }
  if (!m.id) return;
  requests.push(m);
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:m.id, result }) + '\\n');
  if (m.method === 'server/discover') {
    if (process.env.TEST_LEGACY === 'ignore') return;
    if (process.env.TEST_LEGACY === 'yes') return process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:m.id, error:{code:-32601,message:'Unknown method'} }) + '\\n');
    return reply({ supportedVersions:['2026-07-28'] });
  }
  if (m.method === 'initialize') return reply({protocolVersion:'2025-03-26'});
  if (m.method === 'tools/call' && !process.env.TEST_LEGACY && !m.params.inputResponses) {
    process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:m.id, method:'elicitation/create', params:{}}) + '\\n');
    return reply({resultType:'input_required', inputRequests:{question:{method:'elicitation/create',params:{message:'Name?'}}}, requestState:'opaque'});
  }
  reply({content:[{type:'text',text:JSON.stringify({requests,rejected})}]});
});
`;

test.each(["", "yes", "ignore"])("stdio discovers modern or falls back to legacy (%s)", async legacy => {
  const client = await createStdioMcpClient({ name: "fixture", command: process.execPath, args: ["--eval", script], env: { TEST_LEGACY: legacy } });
  let prompts = 0;
  try {
    const result = await client.callTool("ask", {}, undefined, async () => { prompts++; return { action: "decline" }; });
    const trace = JSON.parse((result.content as { text: string }[])[0].text);
    const calls = trace.requests.filter((r: any) => r.method === "tools/call");
    if (legacy) {
      expect(prompts).toBe(0);
      expect(trace.requests.some((r: any) => r.method === "initialize" && !r.params.capabilities.elicitation)).toBe(true);
      expect(calls[0].params._meta).toBeUndefined();
    } else {
      expect(prompts).toBe(1);
      expect(trace.rejected).toBe(true); // Colliding server request did not consume response slot.
      expect(calls).toHaveLength(2);
      expect(calls[0].id).not.toBe(calls[1].id);
      expect(calls[1].params.inputResponses).toEqual({ question: { action: "decline" } });
      expect(calls[1].params.requestState).toBe("opaque");
      expect(calls[0].params._meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({ elicitation: { form: {}, url: {} } });
    }
  } finally { client.close(); }
});

test("closing stdio cancels an outstanding elicitation", async () => {
  const client = await createStdioMcpClient({ name: "fixture", command: process.execPath, args: ["--eval", script], env: { TEST_LEGACY: "" } });
  const started = Promise.withResolvers<void>();
  const call = client.callTool("ask", {}, undefined, async (_params, signal) => {
    started.resolve();
    return new Promise(resolve => signal!.addEventListener("abort", () => resolve({ action: "cancel" }), { once: true }));
  });
  try {
    await started.promise;
    client.close();
    await expect(call).rejects.toThrow();
  } finally { client.close(); }
});
